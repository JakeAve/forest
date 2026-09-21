import type { PrCard } from "./parse.ts";

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
};

export type AutoRebase = { on: true; error: string | null };

export type Repo = {
  name: string;
  path: string;
  webUrl: string | null;
  defaultBranch: string | null;
  worktrees: Worktree[];
  prError?: string | null; // why gh failed here; set by the store at publish
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
};
