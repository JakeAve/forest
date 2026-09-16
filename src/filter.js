export function matchWt(
  { q = "", dirtyOnly = false, runningOnly = false },
  repoName,
  w,
) {
  return (!dirtyOnly || w.dirty > 0) &&
    (!runningOnly || (w.ports?.length ?? 0) > 0) &&
    (!q || w.branch.includes(q) || (repoName ?? "").includes(q));
}

const WORD_START = /[/\-_.# ]/;

export function fuzzy(q, text) {
  if (q === "") return 0;
  const ql = q.toLowerCase();
  const tl = text.toLowerCase();
  let score = 0;
  let from = 0;
  let matched = false;
  for (const ch of ql) {
    const idx = tl.indexOf(ch, from);
    if (idx === -1) return null;
    let bonus = 1;
    if (matched && idx === from) bonus += 3;
    if (idx === 0 || WORD_START.test(tl[idx - 1])) bonus += 2;
    score += bonus - idx * 0.001;
    matched = true;
    from = idx + 1;
  }
  return score;
}

export function rank(q, items, limit = 50) {
  return items
    .map((item, i) => ({
      item,
      i,
      score: fuzzy(q, `${item.label} ${item.detail ?? ""}`),
    }))
    .filter(({ score }) => score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(({ item }) => item);
}
