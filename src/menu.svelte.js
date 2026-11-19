import { tick } from "svelte";
import { clampMenu, trimSeps } from "../parse.ts";
import { clickCell } from "./ui.svelte.js";

class Menu {
  el = $state();
  /** { x, y, items, closable, session } while open. */
  shown = $state(null);
  /** The item under the pointer. */
  cur = $state(null);
  /** The opener to refocus on close, when opened from the keyboard. */
  ret = null;
}
export const menu = new Menu();

class Card {
  el = $state();
  /** { path, x, y, kind }: PR or ticket card under its cell. */
  shown = $state(null);
  /** Which action the card is asking about: { path, key }. */
  asking = $state(null);
  ret = null;
}
export const card = new Card();

// The outside-pointerdown that closes a popover fires before the click on the
// button that opened it, which would reopen it; remember that button so the
// click toggles instead.
let opener = null;
let closedBy = null;
export function noteOutside(ev) {
  if (!opener?.contains(ev.target)) return;
  closedBy = opener;
  addEventListener("pointerup", () => setTimeout(() => (closedBy = null)), {
    once: true,
    capture: true,
  });
}
function reopens(e) {
  const same = e.type === "click" && closedBy === e.currentTarget;
  closedBy = null;
  opener = e.type === "click" ? e.currentTarget : null;
  return same;
}

export async function openMenu(e, items, viaKey) {
  e.preventDefault();
  e.stopPropagation();
  if (reopens(e)) return;
  if (card.shown) hideCard();
  const box = e.currentTarget.getBoundingClientRect();
  menu.ret = viaKey ? e.currentTarget : null;
  menu.shown = {
    x: (!viaKey && e.clientX) || Math.round(box.left + 16),
    y: (!viaKey && e.clientY) || Math.round(box.bottom),
    items: trimSeps(items.filter(Boolean)),
    closable: e.type !== "contextmenu",
  };
  await tick();
  if (!menu.el || !menu.shown) return;
  menu.el.showPopover();
  placeMenu();
  if (viaKey) menu.el.querySelector("button:not(.x)")?.focus();
}

export function placeMenu() {
  const r = menu.el.getBoundingClientRect();
  const p = clampMenu(
    menu.shown.x,
    menu.shown.y,
    r.width,
    r.height,
    innerWidth,
    innerHeight,
  );
  menu.el.style.left = `${p.x}px`;
  menu.el.style.top = `${p.y}px`;
}

export function menuKey(e, items) {
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
    openMenu(e, items, true);
  }
}

export function closeMenu() {
  menu.shown = null;
  menu.cur = null;
  menu.ret?.focus();
  menu.ret = null;
}

export function hideMenu() {
  menu.el?.hidePopover();
  closeMenu();
}

export function runItem(item, e) {
  if (!item.keep) menu.el?.hidePopover();
  item.fn(e);
}

// Swaps the open menu's items in place: the agent popover's drill-down.
export async function drill(items, e, session = null) {
  if (!menu.shown) return;
  menu.cur = null;
  menu.shown = {
    ...menu.shown,
    session,
    items: trimSeps(items.filter(Boolean)),
  };
  await tick();
  placeMenu();
  if (e?.detail === 0) {
    menu.el?.querySelector("button:not(:disabled, .x)")?.focus();
  }
}

// The menu item under focus, else under the pointer; its session is what
// t / c / l act on.
export const curItem = () => {
  const i = menu.el?.contains(document.activeElement) &&
    document.activeElement.dataset.i;
  return i ? menu.shown?.items[+i] : menu.cur;
};
export const menuSession = () =>
  menu.shown && (menu.shown.session ?? curItem()?.agent);

export async function showCard(w, x, y, kind = "pr") {
  card.shown = { path: w.path, x, y, kind };
  await tick();
  if (!card.el || !card.shown) return;
  if (!card.el.matches(":popover-open")) card.el.showPopover();
  placeCard();
}

// A plain click on the PR pill opens its card, as the agent badge opens its
// menu; a modified click still follows the link to GitHub.
export async function openCard(w, e, kind = "pr") {
  e.stopPropagation();
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  if (reopens(e)) return;
  if (menu.shown) hideMenu();
  const box = e.currentTarget.getBoundingClientRect();
  card.ret = e.detail === 0 ? e.currentTarget : null;
  await showCard(w, Math.round(box.left), Math.round(box.bottom + 4), kind);
  if (card.ret) {
    card.el?.querySelector(card.asking ? ".practs .btn" : "a, button")
      ?.focus();
  }
}

export function placeCard() {
  if (!card.el || !card.shown) return;
  const r = card.el.getBoundingClientRect();
  const p = clampMenu(
    card.shown.x,
    card.shown.y,
    r.width,
    r.height,
    innerWidth,
    innerHeight,
  );
  card.el.style.left = `${p.x}px`;
  card.el.style.top = `${p.y}px`;
}

export function hideCard() {
  card.el?.hidePopover();
  card.shown = null;
  card.asking = null;
  card.ret?.focus();
  card.ret = null;
}

export function runAction(a, w, e) {
  e?.stopPropagation();
  if (
    a.confirm && !(card.asking?.path === w.path && card.asking.key === a.key)
  ) {
    card.asking = { path: w.path, key: a.key };
    return;
  }
  card.asking = null;
  a.go(e);
}

// A menu pick of a confirmable action opens the card on its question, so there
// is one confirm UI however you got there -- and no merge on a single misclick.
export function askInCard(w, a, e) {
  card.asking = { path: w.path, key: a.key };
  if (e?.detail !== 0) return showCard(w, e?.clientX ?? 0, e?.clientY ?? 0);
  menu.ret = null;
  clickCell(w, "pr");
}
