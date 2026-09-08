<script>
import { untrack } from "svelte";
import { MergeView } from "@codemirror/merge";
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
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

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
  onstate,
  onconflict,
  onerror,
  onsaved,
  oncopy,
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
let lineUsed = false;

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
    stage.textContent = "stage hunk";
    stage.onclick = () => hunkAct("stage-hunk", this.hunk);
    const disc = document.createElement("button");
    disc.className = "hb d";
    disc.textContent = "discard hunk";
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

function flash(v, ln) {
  v.dispatch({
    effects: setFlash.of(
      Decoration.set([flashLine.range(v.state.doc.line(ln).from)]),
    ),
  });
  setTimeout(
    () =>
      view?.b === v && v.dispatch({ effects: setFlash.of(Decoration.none) }),
    1600,
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
  disk = file.work;
  setDirty(false);
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
  const editable = file.work !== null;
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
        if (u.docChanged) setDirty(true);
      }),
    ]
    : ro;
  view = new MergeView({
    a: { doc: file.base ?? "", extensions: ro },
    b: { doc: file.work ?? "", extensions: bExt },
    parent: el,
    collapseUnchanged: collapse,
  });
  addSplitter();
  applySplit(split);
  if (editable) {
    view.b.dispatch({
      effects: setHunks.of(decosFor(view.b.state.doc, hunks)),
    });
  }
  if (line && !lineUsed) {
    lineUsed = true;
    const b = view.b;
    const l = line >= 1 && line <= b.state.doc.lines
      ? b.state.doc.line(line)
      : null;
    if (l) {
      // post-layout: an immediate dispatch is lost to the initial measure pass
      requestAnimationFrame(() => {
        if (view?.b !== b) return;
        b.dispatch({
          effects: EditorView.scrollIntoView(l.from, { y: "center" }),
        });
        flash(b, line);
        // the a side misses the programmatic scroll of the shared container
        requestAnimationFrame(() => view?.a.requestMeasure());
      });
    }
  }
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

export function reloadTheirs() {
  fetchData().then(build);
}

async function check() {
  const data = await fetchData();
  if (data.file.work === disk) {
    if (view && data.file.work !== null) {
      view.b.dispatch({
        effects: setHunks.of(decosFor(view.b.state.doc, data.hunks)),
      });
    }
    return;
  }
  if (dirty) return onconflict?.();
  build(data);
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
  void wt, void path, void base;
  let stale = false;
  Promise.all([fetchData(), loadLang(path)]).then(([d, l]) => {
    if (stale) return;
    lang = l;
    build(d);
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
  if (view) { for (const v of [view.a, view.b]) v.dispatch({ effects }); }
});

$effect(() => () => view?.destroy());
</script>

<div class="wrap" class:dirtyhide={dirty} bind:this={el}></div>

<style>
.wrap {
  min-height: 100%;
}
.wrap.dirtyhide :global(.hunkbar) {
  display: none;
}
</style>
