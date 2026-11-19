export const ICON = {
  save:
    "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  plus: "M5 12h14M12 5v14",
  minus: "M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  copy:
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2",
  up: "m5 12 7-7 7 7M12 19V5",
  down: "M12 5v14m7-7-7 7-7-7",
  max: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  min: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
};
export const LAYOUTS = [
  ["stack", "Stack", "M4 4h16v5H4zM4 11h16v3H4zM4 16h16v4H4z"],
  ["sidebar", "Sidebar", "M4 4h6v16H4zM12 4h8v6h-8zM12 12h8v8h-8z"],
  ["columns", "Columns", "M3 4h5v16H3zM10 4h4v16h-4zM16 4h5v16h-5z"],
  ["rail", "Rail", "M4 4h6v7H4zM4 13h6v7H4zM12 4h8v16h-8z"],
];

export const CHECK = {
  pass: ["✓", "ok"],
  fail: ["✕", "bad"],
  pending: ["", "warn"],
};
export const TAG = { P0: "bad", P1: "bad", P2: "warn" };
export const TICKET_ST = {
  todo: "off",
  doing: "ok",
  done: "done",
  canceled: "off",
};
export const VERDICT = {
  APPROVED: ["✓ Approved", "ok"],
  CHANGES_REQUESTED: ["! Changes requested", "bad"],
  COMMENTED: ["Commented", "off"],
};

export const AM_ICON =
  '<path d="M1.896 4.559a6.25 6.25 0 0 1 8.839 0 .75.75 0 0 1-1.06 1.061 4.75 4.75 0 1 0 0 6.717L13.03 8.98l-1.553-1.554A.25.25 0 0 1 11.654 7h4.096a.25.25 0 0 1 .25.25v4.096a.25.25 0 0 1-.427.177l-1.482-1.482-3.356 3.356a6.25 6.25 0 0 1-8.839-8.838Z" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>';
export const AR_ICON =
  '<path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/>';
export const AC_ICON =
  '<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" fill="currentColor"/>';
export const GLYPH = {
  conflict:
    '<path d="M8.87 1.5a1 1 0 0 0-1.74 0L.75 12.5A1 1 0 0 0 1.62 14h12.76a1 1 0 0 0 .87-1.5ZM7 6h2v3.5H7Zm1 6.25a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z" fill="currentColor" fill-rule="evenodd"/>',
  fail:
    '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  changes:
    '<path d="M8 2.5v6.5M8 13v.01" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>',
  behind:
    '<path d="M8 2v11.5M3.5 9l4.5 4.5L12.5 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};
