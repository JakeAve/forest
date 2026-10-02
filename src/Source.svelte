<script>
import { untrack } from "svelte";
import { MergeView, presentableDiff } from "@codemirror/merge";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  WidgetType,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import Hex from "./Hex.svelte";
import { decodeChunk, fmtSize, rawUrl } from "../parse.ts";

let {
  wt,
  path,
  base,
  collapse,
  tick = 0,
  line = 0,
  split = 50,
  onsplit,
  wrap = false,
  single = false,
  onstate,
  onconflict,
  onupdated,
  onerror,
  onsaved,
  oncopy,
  onready,
  onbinary,
} = $props();

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.self], class: "tk-kw" },
    { tag: t.comment, class: "tk-cm" },
    { tag: [t.string, t.regexp], class: "tk-str" },
    { tag: [t.number, t.bool, t.null, t.atom], class: "tk-num" },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      class: "tk-fn",
    },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], class: "tk-ty" },
    { tag: [t.propertyName, t.attributeName], class: "tk-prop" },
    { tag: [t.operator, t.meta, t.processingInstruction], class: "tk-op" },
    { tag: [t.heading, t.strong], class: "tk-kw" },
    { tag: [t.link, t.emphasis], class: "tk-str" },
    { tag: t.invalid, class: "tk-bad" },
  ]),
);

const wrapC = new Compartment();
const wrapExt = (on) => (on ? EditorView.lineWrapping : []);

let el;
let view = null;
let lang = [];
let disk = null;
let dirty = $state(false);
let skip = $state(null);
let note = $state(null);
let sentinel;
let stream = null;
const CHUNK = 1 << 20;
let loading = $state(true);
let usedLine = 0;
let builtWt = null;
let builtPath = null;
let applying = false; // a disk update is being dispatched: not a user edit

const mkDecoField = (effect) =>
  StateField.define({
    create: () => Decoration.none,
    update(d, tr) {
      d = d.map(tr.changes);
      for (const e of tr.effects) if (e.is(effect)) d = e.value;
      return d;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
const setHunks = StateEffect.define();
const hunkField = mkDecoField(setHunks);
const setFlash = StateEffect.define();
const flashField = mkDecoField(setFlash);
const flashLine = Decoration.line({ class: "lineflash" });

class HunkBar extends WidgetType {
  constructor(hunk) {
    super();
    this.hunk = hunk;
  }
  eq(o) {
    return o.hunk.patch === this.hunk.patch;
  }
  toDOM() {
    const bar = document.createElement("div");
    bar.className = "hunkbar";
    const h = document.createElement("span");
    h.className = "hh";
    h.textContent = this.hunk.header;
    const sp = document.createElement("span");
    sp.className = "sp";
    const stage = document.createElement("button");
    stage.className = "hb";
    stage.textContent = "Stage hunk";
    stage.onclick = () => hunkAct("stage-hunk", this.hunk);
    const disc = document.createElement("button");
    disc.className = "hb d";
    disc.textContent = "Discard hunk";
    disc.onclick = () => hunkAct("discard-hunk", this.hunk);
    bar.append(h, sp, stage, disc);
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

function decosFor(doc, hunks) {
  return Decoration.set(
    hunks.map((h) => {
      const line = Math.min(Math.max(h.startB, 1), doc.lines);
      return Decoration.widget({
        widget: new HunkBar(h),
        block: true,
        side: -1,
      })
        .range(doc.line(line).from);
    }),
    true,
  );
}

function scrollToLine(ln) {
  usedLine = ln;
  const b = view.b;
  const l = ln >= 1 && ln <= b.state.doc.lines ? b.state.doc.line(ln) : null;
  if (!l) return;
  // post-layout: an immediate dispatch is lost to the initial measure pass
  requestAnimationFrame(() => {
    if (view?.b !== b) return;
    b.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    flash(b, ln);
    // the a side misses the programmatic scroll of the shared container
    requestAnimationFrame(() => view?.a?.requestMeasure());
  });
}

function flash(v, ln) {
  flashLines(v, [[ln, ln]]);
}

function flashLines(v, ranges) {
  const lines = new Set();
  for (const [a, b] of ranges) for (let l = a; l <= b; l++) lines.add(l);
  v.dispatch({
    effects: setFlash.of(
      Decoration.set(
        [...lines].sort((a, b) => a - b).map((l) =>
          flashLine.range(v.state.doc.line(l).from)
        ),
      ),
    ),
  });
  setTimeout(
    () =>
      view?.b === v && v.dispatch({ effects: setFlash.of(Decoration.none) }),
    1600,
  );
}

// Patch the editor to what is on disk instead of rebuilding it: scroll,
// cursor, selection and history survive, and only the changed lines flash. A
// reader parked at the end stays at the end, so a growing log tails itself.
function applyDisk(work) {
  const b = view.b;
  const sd = b.scrollDOM;
  const atEnd = sd.scrollTop + sd.clientHeight >= sd.scrollHeight - 4;
  const changes = presentableDiff(b.state.doc.toString(), work).map((c) => ({
    from: c.fromA,
    to: c.toA,
    insert: work.slice(c.fromB, c.toB),
  }));
  if (!changes.length) return;
  applying = true;
  try {
    b.dispatch({
      changes,
      annotations: Transaction.addToHistory.of(false),
      effects: atEnd ? EditorView.scrollIntoView(work.length) : [],
    });
  } finally {
    applying = false;
  }
  const doc = b.state.doc;
  flashLines(
    b,
    presentableDiff(disk ?? "", work).map((c) => [
      doc.lineAt(c.fromB).number,
      doc.lineAt(Math.max(c.fromB, c.toB - 1)).number,
    ]),
  );
}

function copyLine(v, block, e) {
  const ln = v.state.doc.lineAt(block.from).number;
  const text = `${e.detail > 1 ? wt + "/" + path : path}:${ln}`;
  navigator.clipboard.writeText(text);
  oncopy?.(text);
  flash(v, ln);
  return true;
}

const clampSplit = (p) => Math.min(85, Math.max(15, Math.round(p)));

function applySplit(pct) {
  const [a, b] = view?.dom.querySelectorAll(".cm-mergeViewEditor") ?? [];
  if (!a) return;
  a.style.flexGrow = pct;
  b.style.flexGrow = 100 - pct;
}

function addSplitter() {
  const eds = view.dom.querySelector(".cm-mergeViewEditors");
  const h = document.createElement("div");
  h.className = "vsplit";
  h.setAttribute("role", "separator");
  h.setAttribute("aria-orientation", "vertical");
  h.tabIndex = 0;
  h.onmousedown = (e) => {
    e.preventDefault();
    const r = eds.getBoundingClientRect();
    let pct = split;
    const mv = (m) =>
      applySplit(pct = clampSplit((m.clientX - r.left) / r.width * 100));
    const up = () => {
      removeEventListener("mousemove", mv);
      removeEventListener("mouseup", up);
      onsplit?.(pct);
    };
    addEventListener("mousemove", mv);
    addEventListener("mouseup", up);
  };
  h.ondblclick = () => onsplit?.(50);
  h.onkeydown = (e) => {
    const d = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
    if (!d) return;
    e.preventDefault();
    onsplit?.(clampSplit(split + d));
  };
  eds.insertBefore(h, eds.lastChild);
}

function setDirty(d) {
  if (dirty === d) return;
  dirty = d;
  onstate?.(d);
}

async function fetchData() {
  const q = `wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}`;
  const [fr, hr] = await Promise.all([
    fetch(`/api/file?${q}&base=${base}`),
    fetch(`/api/hunks?${q}`),
  ]);
  return { file: await fr.json(), hunks: await hr.json() };
}

function build({ file, hunks }) {
  view?.destroy();
  view = null;
  disk = file.work;
  setDirty(false);
  skip = file.skip ?? null;
  onbinary?.(!!skip);
  stream = null;
  note = file.encoding ? `${file.encoding.toUpperCase()} · read-only` : null;
  if (skip) return;
  const theme = EditorView.theme({}, { dark: true });
  const ro = [
    wrapC.of(wrapExt(wrap)),
    lang,
    highlight,
    lineNumbers(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    theme,
  ];
  const editable = file.work !== null && !file.encoding;
  const bExt = editable
    ? [
      lineNumbers({ domEventHandlers: { click: copyLine } }),
      EditorView.theme({ ".cm-gutters": { cursor: "pointer" } }),
      history(),
      keymap.of([
        { key: "Mod-s", run: () => (save(), true), preventDefault: true },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      wrapC.of(wrapExt(wrap)),
      lang,
      highlight,
      theme,
      hunkField,
      flashField,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applying) setDirty(true);
      }),
    ]
    : ro;
  if (single || file.large || file.encoding) {
    const box = el.appendChild(document.createElement("div"));
    box.className = "cm-mergeView";
    const b = new EditorView({
      doc: file.work ?? file.base ?? "",
      extensions: bExt,
      parent: box,
    });
    view = { a: null, b, dom: box, destroy: () => (b.destroy(), box.remove()) };
  } else {
    view = new MergeView({
      a: { doc: file.base ?? "", extensions: ro },
      b: { doc: file.work ?? "", extensions: bExt },
      parent: el,
      collapseUnchanged: collapse,
    });
    addSplitter();
    applySplit(split);
  }
  if (editable) {
    view.b.dispatch({
      effects: setHunks.of(decosFor(view.b.state.doc, hunks)),
    });
  }
  builtWt = wt;
  builtPath = path;
  if (file.large) {
    stream = {
      src: rawUrl(wt, path),
      off: 0,
      size: file.large,
      dec: new TextDecoder(file.encoding ?? "utf-8"),
      carry: "",
      busy: false,
    };
    more();
  }
  if (line && line !== usedLine) scrollToLine(line);
  onready?.();
}

export const cursor = () => view?.b.state.selection.main.head ?? 0;

export function setCursor(head) {
  if (!view) return;
  view.b.dispatch({
    selection: { anchor: Math.min(head, view.b.state.doc.length) },
  });
  view.b.contentDOM.focus({ preventScroll: true });
}

async function hunkAct(kind, hunk) {
  if (dirty) {
    return onerror?.("Unsaved edits — save or undo them before hunk actions.");
  }
  const res = await fetch(`/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wt, path, patch: hunk.patch }),
  });
  if (!res.ok) return onerror?.(await res.text());
  build(await fetchData());
  onsaved?.();
}

export async function save() {
  if (!view || !dirty) return;
  const content = view.b.state.doc.toString();
  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wt, path, content, expect: disk }),
  });
  if (res.status === 409) return onconflict?.();
  if (!res.ok) return onerror?.(await res.text());
  disk = content;
  setDirty(false);
  const { hunks } = await fetchData();
  view.b.dispatch({ effects: setHunks.of(decosFor(view.b.state.doc, hunks)) });
  onsaved?.();
}

async function more() {
  const s = stream;
  if (!s || s.busy || s.off >= s.size) return;
  s.busy = true;
  const buf = await fetch(s.src, {
    headers: { Range: `bytes=${s.off}-${s.off + CHUNK - 1}` },
  }).then((r) => r.ok ? r.arrayBuffer() : null)
    .then((b) => b && new Uint8Array(b), () => null);
  if (stream !== s || !view) return;
  s.busy = false;
  if (!buf?.length) {
    stream = null;
    note = `load failed at ${fmtSize(s.off)} of ${fmtSize(s.size)}`;
    return;
  }
  s.off += buf.length;
  const b = view.b;
  b.dispatch({
    changes: {
      from: b.state.doc.length,
      insert: decodeChunk(s, buf, s.off >= s.size),
    },
  });
  const enc = s.dec.encoding;
  note = `${fmtSize(s.off)} of ${fmtSize(s.size)} loaded${
    enc === "utf-8" ? "" : ` · ${enc.toUpperCase()} · read-only`
  }`;
  requestAnimationFrame(() => near() && more());
}

const AHEAD = 2000;
function near() {
  const box = sentinel?.parentElement?.getBoundingClientRect();
  return !!box && sentinel.getBoundingClientRect().top < box.bottom + AHEAD;
}

$effect(() => {
  const io = new IntersectionObserver((es) => es[0].isIntersecting && more(), {
    root: sentinel.parentElement,
    rootMargin: `0px 0px ${AHEAD}px 0px`,
  });
  io.observe(sentinel);
  return () => io.disconnect();
});

export function reloadTheirs() {
  fetchData().then(build);
}

// ponytail: large files have work === disk === null, so a growing log never refreshes; compare size if that matters
async function check() {
  const [w, p] = [wt, path];
  const data = await fetchData();
  if (w !== wt || p !== path || loading) return;
  const { file } = data;
  if (file.work === disk) {
    if (view && file.work !== null) {
      view.b.dispatch({
        effects: setHunks.of(decosFor(view.b.state.doc, data.hunks)),
      });
    }
    return;
  }
  if (dirty) return onconflict?.();
  // gone from disk: keep showing what we had, read-only in spirit; a ⌘S
  // writes it back because disk is now null and save's expect matches
  if (
    file.work === null && disk !== null && view && !file.skip && !file.large
  ) {
    disk = null;
    note = "Deleted on disk";
    onupdated?.();
    return;
  }
  const sameBase = view?.a
    ? view.a.state.doc.toString() === (file.base ?? "")
    : true;
  if (!view || skip || file.skip || file.large || file.encoding || !sameBase) {
    return build(data);
  }
  applyDisk(file.work);
  disk = file.work;
  note = null;
  onupdated?.();
  view.b.dispatch({
    effects: setHunks.of(decosFor(view.b.state.doc, data.hunks)),
  });
}

// language-data has no entry for these; the nearest mode it does have
const ALIAS = { svelte: "html", jsonc: "json", "deno.lock": "json" };

async function loadLang(p) {
  const f = p.split("/").pop();
  const alias = ALIAS[f] ?? ALIAS[f.split(".").pop()];
  const desc = alias
    ? LanguageDescription.matchLanguageName(languages, alias)
    : LanguageDescription.matchFilename(languages, f);
  return desc ? [await desc.load()] : [];
}

$effect(() => {
  void wt, void path;
  usedLine = 0;
});

$effect(() => {
  const ln = line;
  if (ln && ln !== usedLine && view && builtWt === wt && builtPath === path) {
    scrollToLine(ln);
  }
});

$effect(() => {
  void wt, void path, void base, void single;
  stream = null;
  skip = null;
  let stale = false;
  loading = true;
  Promise.all([fetchData(), loadLang(path)]).then(([d, l]) => {
    if (stale) return;
    lang = l;
    build(d);
  }).finally(() => {
    if (!stale) loading = false;
  });
  return () => {
    stale = true;
  };
});

$effect(() => {
  if (tick) untrack(() => check());
});

$effect(() => {
  applySplit(split);
});

$effect(() => {
  const effects = wrapC.reconfigure(wrapExt(wrap));
  if (view) { for (const v of [view.a, view.b]) v?.dispatch({ effects }); }
});

$effect(() => () => {
  stream = null;
  view?.destroy();
});
</script>

{#if loading}<div
  class="loading late"><span><i class="spin"></i>Loading…</span></div>{/if}
{#if skip}
  {#key path}<Hex src="{rawUrl(wt, path)}&t={tick}" note={skip} />{/key}
{/if}
{#if note && !skip}<div class="note">{note}</div>{/if}
<div class="wrap" class:dirtyhide={dirty} class:stale={loading}
  hidden={!!skip} bind:this={el}></div>
<div bind:this={sentinel}></div>

<style>
.wrap {
  min-height: 100%;
}
.wrap.stale {
  opacity: 0.5;
  transition: opacity 0s 150ms;
}
.loading {
  position: sticky;
  top: 0;
  z-index: 5;
  height: 0;
  display: flex;
  justify-content: center;
}
.loading span {
  margin-top: 1rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg2);
  color: var(--dim);
  font: 0.75rem var(--sans);
}
.note {
  padding: 0.5rem 1rem;
  color: var(--dimmer);
  font: 0.75rem var(--mono);
}
.wrap.dirtyhide :global(.hunkbar) {
  display: none;
}
</style>
