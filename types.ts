import type { PrCard, Ticket } from "./parse.ts";

export type Procs = { port: number; pid: number; command: string }[];

export type Worktree = {
  repo: string;
  path: string;
  branch: string;
  head: string;
  ahead: number | null;
  behind: number | null;
  aheadMain: number | null;
  behindMain: number | null;
  gone: boolean;
  state: "rebase" | "merge" | "cherry-pick" | "detached" | null;
  dirty: number;
  staged: number;
  modified: number;
  untracked: number;
  subject: string;
  author: string;
  lastActivity: number;
  isPrimary: boolean;
  remote: string | null;
  ports: number[];
  procs: Procs;
  pr: Pr | null;
  autoRebase: AutoRebase | null;
  agents: AgentSession[];
};

// An agent session that mentions this worktree, earliest mention first: the
// first one is most likely the session that created it. Slim, since it rides
// every snapshot; the `sessions` tool has the rest (SessionInfo).
export type AgentSession = {
  agent: string;
  id: string;
  title: string;
  seenAt: number; // first mention of this worktree
  deep: boolean; // worked inside it, not just named it (e.g. a listing)
};

export type SessionInfo = {
  agent: string;
  label: string;
  id: string;
  title: string;
  cwd: string; // where it started; the resume command runs here
  startedAt: number;
  transcript: string; // the session's own transcript file
  url: string; // opens it in its app
  command: string; // resumes it in a terminal
};

export type AutoRebase = { on: true; error: string | null };

export type Repo = {
  name: string;
  path: string;
  webUrl: string | null;
  defaultBranch: string | null;
  worktrees: Worktree[];
  prError?: string | null; // why gh failed here; set by the store at publish
  prListed?: boolean;
  cached?: boolean; // restored from the cache, not yet re-read this boot
};

export type Pr = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  // GitHub's own createdAt/closedAt/mergedAt for the current state.
  stateSince: number;
  title: string;
  isDraft: boolean;
  baseRefName: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: string; // GitHub mergeStateStatus
  autoMerge: boolean;
  ci: { state: "pass" | "fail" | "pending" | null; failing: string[] };
  // GitHub's own check-run/review timestamps for the current ci.state /
  // reviewDecision; falls back to when Forest first observed it if GitHub
  // has no matching timestamp (e.g. a state with no reviews yet).
  ciSince: number | null;
  reviewSince: number | null;
  approvals: number;
  card: PrCard | null; // hover card detail, from CARD_QUERY
  detailAt: number | null;
};

export type PrSlim = Pick<Pr, "number" | "url" | "state" | "stateSince">;

export type PrDetail = Omit<Pr, "number" | "url" | "state" | "stateSince">;

export type Tree = { files: string[]; dirs: string[]; ignored: string[] };

export type WtRow = Worktree & {
  webUrl: string | null;
  defaultBranch: string | null;
  ticket: Ticket | null;
};
