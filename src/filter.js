export function matchWt(
  { q = "", dirtyOnly = false, runningOnly = false },
  repoName,
  w,
) {
  return (!dirtyOnly || w.dirty > 0) &&
    (!runningOnly || (w.ports?.length ?? 0) > 0) &&
    (!q || w.branch.includes(q) || (repoName ?? "").includes(q));
}
