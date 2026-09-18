import {
  approvals,
  ciSince,
  ciSummary,
  pool,
  type PrCard,
  prCard,
  reviewSince,
} from "./parse.ts";
import type { Shell } from "./exec.ts";
import type { Settings } from "./settings.ts";
import type { Stats } from "./stats.ts";
import type { Pr, PrDetail, PrSlim, Repo, Worktree } from "./types.ts";

// ponytail: fixed ceilings, not adaptive — ~128 `git` and 8 `gh` per sweep;
// concurrent polls stack on top, so this is a per-sweep bound, not a system one.
export const PR_JOBS = 8; // `gh`: own knob, 7x `git`'s RSS per process

const NO_DETAIL: PrDetail = {
  title: "",
  isDraft: false,
  baseRefName: "",
  reviewDecision: "",
  mergeable: "UNKNOWN",
  mergeState: "UNKNOWN",
  autoMerge: false,
  ci: { state: null, failing: [] },
  ciSince: null,
  reviewSince: null,
  approvals: 0,
  card: null,
  detailAt: null,
};

const PR_VIEW_FIELDS =
  "title,isDraft,baseRefName,reviewDecision,mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup,reviews";

// ponytail: first 100 threads/checks, last 100 reviews and 50 comments
const CARD_QUERY =
  `query($owner:String!,$repo:String!,$n:Int!,$head:String!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
author{login} createdAt updatedAt additions deletions changedFiles headRefName mergeStateStatus
baseRef{compare(headRef:$head){aheadBy behindBy}}
reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Bot{login} ... on Team{name} ... on Mannequin{login}}}}
reviews(last:100){nodes{author{login} state submittedAt url body}}
reviewThreads(first:100){nodes{isResolved path line originalLine comments(first:1){totalCount nodes{author{login} body url createdAt}} last:comments(last:1){nodes{author{login}}}}}
comments(last:50){nodes{author{login} body url createdAt}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
... on CheckRun{name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$n)}
... on StatusContext{context state createdAt targetUrl isRequired(pullRequestNumber:$n)}}}}}}}}}}`;

const PR_PUSH_MS = 10_000;
const GH_RETRY_MS = [600_000, 3_600_000];

export type PrsApi = {
  refreshPrs(repos: Repo[]): Promise<void>;
  refreshOnePr(repo: string, n: number): Promise<void>;
  refreshPrSoon(repo: string, n: number): void;
  prFor(repo: string, w: Worktree): Pr | null;
  pushSoon(repo: string, now: number): void;
  expire(repo: string): void;
  isFailed(repo: string): boolean;
};

export function createPrs(
  { sh, settings, stats, onChange }: {
    sh: Shell;
    settings: Settings;
    stats: Stats;
    onChange: () => void;
  },
): PrsApi {
  const { exec } = sh;
  const prsByRepo = new Map<string, Map<string, PrSlim>>();
  const prDetail = new Map<string, PrDetail>();
  // repo path -> earliest next gh call. Only an OPEN pr can change under us, so a
  // repo without one is checked on the idle floor: enough to notice a PR opened in
  // a browser, cheap enough to leave running all day.
  const ghNextAt = new Map<string, number>();
  const ghFailed = new Set<string>(); // reported once per repo, not once per call

  const prFor = (repo: string, w: Worktree): Pr | null => {
    const prs = prsByRepo.get(repo);
    const p = prs?.get(w.branch) ?? (w.remote ? prs?.get(w.remote) : null);
    return p
      ? { ...p, ...(prDetail.get(`${repo}#${p.number}`) ?? NO_DETAIL) }
      : null;
  };

  async function fetchCard(repo: string, n: number): Promise<PrCard | null> {
    try {
      return prCard(JSON.parse(
        await exec(repo, [
          "gh",
          "api",
          "graphql",
          "-F",
          "owner={owner}",
          "-F",
          "repo={repo}",
          "-F",
          `n=${n}`,
          // the PR's own head ref: lets one query ask GitHub how far the branch
          // is from its base without threading the branch name in here.
          "-F",
          `head=refs/pull/${n}/head`,
          "-f",
          `query=${CARD_QUERY}`,
          "--jq",
          ".data.repository.pullRequest",
        ]),
      ));
    } catch {
      return null;
    }
  }

  function prDetailFields(
    // deno-lint-ignore no-explicit-any
    d: any,
    card: PrCard | null,
    prev?: PrDetail,
  ): PrDetail {
    const now = Date.now();
    const reviewDecision = d.reviewDecision ?? "";
    const ci = ciSummary(d.statusCheckRollup ?? []);
    return {
      title: d.title,
      isDraft: d.isDraft,
      baseRefName: d.baseRefName,
      reviewDecision,
      mergeable: d.mergeable,
      mergeState: d.mergeStateStatus ?? "UNKNOWN",
      autoMerge: !!d.autoMergeRequest,
      ci,
      ciSince: ciSince(d.statusCheckRollup ?? [], ci.state) ??
        (prev && prev.ci.state === ci.state ? prev.ciSince : now),
      reviewSince: reviewSince(d.reviews ?? [], reviewDecision) ??
        (prev && prev.reviewDecision === reviewDecision
          ? prev.reviewSince
          : now),
      approvals: approvals(d.reviews ?? []),
      card: card ?? prev?.card ?? null,
      detailAt: null,
    };
  }

  async function refreshPrs(repos: Repo[]) {
    const now = Date.now();
    // no origin remote, no PRs -- ever. The rest run on their own clock.
    const due = repos.filter((r) =>
      r.webUrl && now >= (ghNextAt.get(r.path) ?? 0)
    );
    const jobs: [string, number][] = [];
    await pool(PR_JOBS, due, async (r) => {
      const out = await exec(r.path, [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,url,headRefName,state,createdAt,closedAt,mergedAt",
      ]).catch((e) => {
        stats.ghFailTotal++;
        const first = !ghFailed.has(r.path);
        if (first) {
          ghFailed.add(r.path);
          console.error(`gh pr list failed in ${r.name}:`, e.message);
        }
        ghNextAt.set(r.path, Date.now() + GH_RETRY_MS[first ? 0 : 1]);
        return null;
      });
      if (out === null) return;
      ghFailed.delete(r.path);
      const byBranch = new Map<string, PrSlim>();
      for (
        const p of JSON.parse(out) as {
          number: number;
          url: string;
          headRefName: string;
          state: "OPEN" | "MERGED" | "CLOSED";
          createdAt: string;
          closedAt: string | null;
          mergedAt: string | null;
        }[]
      ) {
        const since = Date.parse(
          p.state === "MERGED"
            ? p.mergedAt!
            : p.state === "CLOSED"
            ? p.closedAt!
            : p.createdAt,
        );
        const cur = byBranch.get(p.headRefName);
        if (!cur || (cur.state !== "OPEN" && p.number > cur.number)) {
          byBranch.set(p.headRefName, {
            number: p.number,
            url: p.url,
            state: p.state,
            stateSince: since,
          });
        }
      }
      prsByRepo.set(r.path, byBranch);
      // read off this repo's own worktrees, not the PR list: a teammate's open PR
      // cannot change anything Forest draws.
      const open = [
        ...new Set(
          r.worktrees.map((w) =>
            byBranch.get(w.branch) ?? (w.remote ? byBranch.get(w.remote) : null)
          ).filter((p) => p?.state === "OPEN").map((p) => p!.number),
        ),
      ];
      const keep = new Set(open.map((n) => `${r.path}#${n}`));
      for (const k of prDetail.keys()) {
        if (k.startsWith(`${r.path}#`) && !keep.has(k)) prDetail.delete(k);
      }
      for (const n of open) jobs.push([r.path, n]);
      ghNextAt.set(
        r.path,
        Date.now() + (open.length ? settings.prPollMs : settings.prIdleMs),
      );
    });
    await pool(PR_JOBS, jobs, async ([repo, n]) => {
      const cardP = fetchCard(repo, n);
      const out = await exec(repo, [
        "gh",
        "pr",
        "view",
        String(n),
        "--json",
        PR_VIEW_FIELDS,
      ]).catch((e) => {
        stats.ghFailTotal++;
        const first = !ghFailed.has(repo);
        if (first) {
          ghFailed.add(repo);
          console.error(`gh pr view failed in ${repo}:`, e.message);
        }
        ghNextAt.set(repo, Date.now() + GH_RETRY_MS[first ? 0 : 1]);
        return null;
      });
      if (out === null) return;
      const prev = prDetail.get(`${repo}#${n}`);
      const fields = prDetailFields(
        JSON.parse(out),
        await cardP,
        prev,
      );
      if (
        prev &&
        JSON.stringify({ ...prev, detailAt: null }) ===
          JSON.stringify({ ...fields, detailAt: null })
      ) {
        return;
      }
      prDetail.set(`${repo}#${n}`, { ...fields, detailAt: Date.now() });
    });
  }

  // After a user-triggered mutation (update-branch, auto-merge) on one PR, pull
  // it straight from gh instead of waiting for the next refreshPrs sweep — the
  // change should show up now, not up to prPollMs later. Best-effort: caller
  // swallows failures, since the mutation itself already succeeded.
  async function refreshOnePr(repo: string, n: number): Promise<void> {
    const cardP = fetchCard(repo, n);
    const out = await exec(repo, [
      "gh",
      "pr",
      "view",
      String(n),
      "--json",
      `state,createdAt,closedAt,mergedAt,${PR_VIEW_FIELDS}`,
    ]);
    const d = JSON.parse(out);
    const key = `${repo}#${n}`;

    const since = Date.parse(
      d.state === "MERGED"
        ? d.mergedAt
        : d.state === "CLOSED"
        ? d.closedAt
        : d.createdAt,
    );
    const byBranch = prsByRepo.get(repo);
    if (byBranch) {
      for (const [branch, slim] of byBranch) {
        if (slim.number === n) {
          byBranch.set(branch, { ...slim, state: d.state, stateSince: since });
        }
      }
    }

    prDetail.set(key, {
      ...prDetailFields(d, await cardP, prDetail.get(key)),
      detailAt: Date.now(),
    });
    onChange();
  }

  // GitHub recomputes mergeability after a mutation, so the read above can still
  // carry the old mergeStateStatus -- or UNKNOWN, which the pill shows as
  // "Checking". Read once more after the beat the watcher already waits after a
  // push. Unrefed: a pending recheck must not hold up shutdown.
  function refreshPrSoon(repo: string, n: number): void {
    const t = setTimeout(
      () => void refreshOnePr(repo, n).catch(() => {}),
      PR_PUSH_MS,
    );
    Deno.unrefTimer(t);
  }

  return {
    refreshPrs,
    refreshOnePr,
    refreshPrSoon,
    prFor,
    pushSoon: (repo, now) => {
      if (!ghFailed.has(repo)) ghNextAt.set(repo, now + PR_PUSH_MS);
    },
    expire: (repo) => void ghNextAt.delete(repo),
    isFailed: (repo) => ghFailed.has(repo),
  };
}
