export function matchWt(
  { q = "", dirtyOnly = false, runningOnly = false },
  repoName,
  w,
) {
  return (!dirtyOnly || w.dirty > 0) &&
    (!runningOnly || (w.ports?.length ?? 0) > 0) &&
    wtScore(q, w, repoName) !== null;
}

export const wtText = (w, repoName = w.repo) =>
  [w.branch, repoName, w.ticket?.key, w.pr && `#${w.pr.number}`]
    .filter(Boolean).join("\n");

const agentText = (w) =>
  (w.agents ?? []).map((a) => `${a.title}\n${a.id}`).join("\n");

// Session titles and ids are long, so they match as a substring, not fuzzily.
function inAgents(q, w) {
  const { text, re } = parseQuery(q);
  const t = agentText(w);
  return re
    ? re.test(t)
    : !!text && t.toLowerCase().includes(text.toLowerCase());
}

export const wtScore = (q, w, repoName = w.repo) =>
  matcher(q)(wtText(w, repoName)) ?? (inAgents(q, w) ? 0 : null);

export const pathText = (p) => `${p.slice(p.lastIndexOf("/") + 1)}\n${p}`;

export const matchPath = (q, p) => matcher(q)(pathText(p)) !== null;

export function parseQuery(q) {
  const body = /^\/(.*?)(?<!\\)\/?$/s.exec(q)?.[1];
  if (body === undefined) return { text: q };
  if (!body) return { text: "" };
  try {
    return { re: new RegExp(body, "im") };
  } catch (e) {
    return { error: e.message };
  }
}

let last = null;
export function matcher(q) {
  if (last?.q === q) return last.fn;
  const { text, re, error } = parseQuery(q);
  const fn = error
    ? () => null
    : re
    ? (t) => (re.test(t) ? 0 : null)
    : (t) => fuzzy(text, t);
  last = { q, fn };
  return fn;
}

const WORD_START = /[/\-_.# ]/;

export function fuzzy(q, text) {
  if (q === "") return 0;
  const ql = q.toLowerCase();
  const tl = text.toLowerCase().replaceAll("\n", " ");
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

export function rank(
  q,
  items,
  limit = 50,
  text = (item) => `${item.label}\n${item.detail ?? ""}`,
) {
  const match = matcher(q);
  return rankBy(items, limit, (item) => match(text(item)));
}

export function rankBy(items, limit, score) {
  return items
    .map((item, i) => ({ item, i, score: score(item) }))
    .filter(({ score }) => score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function findAll(q, text) {
  const { text: t, re } = parseQuery(q);
  const src = re?.source ?? t?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!src) return [];
  return [...text.matchAll(new RegExp(src, "gim"))]
    .filter((m) => m[0])
    .map((m) => [m.index, m.index + m[0].length]);
}
