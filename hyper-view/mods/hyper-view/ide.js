// IDE primitives shared by the content views (dashboard, lists, chat, task panel, forms).
// Patterns: Linear (dense lists, quiet section headers, hover actions with shortcut hints),
// GitHub Primer (relative time with the exact time on hover; empty state = why + one action),
// Raycast (an action shows its shortcut on the right), Zed / VS Code (1px separated panels, 28px rows).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { T } from "./tokens.js";
import { clear } from "./lib.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const msOf = (ts) => (ts ? new Date(ts).getTime() : NaN);

// "now", "5m", "3h", "2d"; older than 30 days: "Nov 2" (Primer RelativeTime switches to a date after P30D).
export function relShort(ts) {
  const s = (Date.now() - msOf(ts)) / 1000;
  if (!ts || !Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
// Exact local time for tooltips: "Sat Nov 15 2026, 14:03:12".
export function exactTime(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d)) return "";
  return `${d.toDateString()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// Relative time label with the exact time as its tooltip (needs a unique id).
export function relTime(t, id, ts, { color, size = T.text.xs, text } = {}) {
  return div().id(id).flex_none().text_size(size).text_color(color ?? t.dim).tooltip(exactTime(ts) || "—").child(text ?? relShort(ts));
}

// Keyboard hint chip: "A", "↵", "Esc".
export function kbd(t, key) {
  return h_flex().flex_none().h(16).min_w(16).px(T.sp.xs).items_center().justify_center().rounded(T.r.chip)
    .border_1().border_color(t.border).bg(t.background).text_size(T.text.micro).text_color(t.dim).child(key);
}

// Section header: 11px medium dim, sentence case, optional count and right-side slot (VS Code panel header, Linear group header).
export function section(t, title, { count, right, id, onClick } = {}) {
  let el = h_flex().h(T.h.rowDense).gap(T.sp.sm).items_center()
    .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(title))
    .when(count != null && count !== "", (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(String(count))))
    .child(div().flex_1())
    .when(Boolean(right), (e) => e.child(right));
  if (id) el = el.id(id);
  if (onClick) el = el.cursor_pointer().on_click((_e, cx) => { onClick(cx); cx.notify(); });
  return el;
}

// Panel header (drop-in for lib.cardHeader): one 36px line — 11px medium title, a dim count/meta, actions right.
// "Tasks (7)" becomes title "Tasks" + count "7". No second explanatory line (VS Code / Zed panel headers).
export function cardHead(t, title, right, sub) {
  const m = typeof title === "string" ? /^(.*) \((\d+)\)$/.exec(title) : null;
  const meta = m ? m[2] : sub;
  return h_flex().h(36).flex_none().px(T.pad.card).gap(T.sp.sm).items_center()
    .child(div().flex_none().text_size(T.text.xs).font_medium().text_color(t.muted).child(m ? m[1] : title))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(meta ? String(meta) : ""))
    .when(Boolean(right), (e) => e.child(right));
}

// Empty state: one dim line, one action (link-styled) and its shortcut.
export function emptyLine(t, id, text, action) {
  return h_flex().id(id).h(T.h.row).px(T.sp.md).gap(T.sp.md).items_center()
    .child(div().min_w(0).truncate().text_size(T.text.sm).text_color(t.dim).child(text))
    .when(Boolean(action), (e) => e.child(h_flex().id(`${id}-act`).flex_none().gap(T.sp.sm).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((ev, cx) => { action[1](ev, cx); cx.notify(); })
      .child(div().text_size(T.text.sm).font_medium().text_color(t.accent).hover((s) => s.opacity(0.8)).child(action[0]))
      .when(Boolean(action[2]), (x) => x.child(kbd(t, action[2])))));
}

// Skeleton lines while data loads (instead of a blank flash): n rows of quiet bars.
const WIDTHS = [62, 48, 70, 40, 56, 66, 44, 52];
export function skeleton(t, n = 5, { avatar = true, h = T.h.row } = {}) {
  return v_flex().w_full().children(Array.from({ length: n }, (_, i) => h_flex().h(h).px(T.sp.md).gap(T.sp.md).items_center()
    .when(avatar, (e) => e.child(div().flex_none().size(16).rounded_full().bg(t.raised)))
    .child(div().flex_none().w(110).h(8).rounded(T.r.chip).bg(t.raised))
    .child(div().h(8).w(`${WIDTHS[i % WIDTHS.length]}%`).rounded(T.r.chip).bg(t.raised).opacity(0.6))));
}

// Hover state for rows (gpui has no group-hover): one hovered key per list.
const HOV = (globalThis.__hvIdeHover ??= {});
export const hovered = (list, key) => HOV[list] === key;
export function trackHover(el, list, key) {
  return el.on_hover((h, cx) => { const n = h ? key : HOV[list] === key ? null : HOV[list]; if (n !== HOV[list]) { HOV[list] = n; cx.notify(); } });
}

// Hover action: ghost text button with its shortcut chip (Raycast action-panel style).
export function hoverAction(t, id, label, fn, key) {
  return h_flex().id(id).flex_none().h(22).pl(T.sp.md).pr(key ? T.sp.xs : T.sp.md).gap(T.sp.sm).rounded(T.r.ctrl).items_center().cursor_pointer()
    .text_size(T.text.xs).font_medium().text_color(t.muted).bg(clear).hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); fn(cx, e); cx.notify(); })
    .child(label).when(Boolean(key), (e) => e.child(kbd(t, key)));
}

// Column cell of an IDE list: fixed width, truncating, tabular text.
export function cell(t, w, text, { color, size = T.text.sm, right = false, grow = false } = {}) {
  let el = div().min_w(0).truncate().text_size(size).text_color(color ?? t.foreground);
  el = grow ? el.flex_1() : el.flex_none().w(w);
  if (right) el = el.text_right();
  return el.child(text ?? "");
}
// Column header row for IDE lists (11px dim, same widths as the cells).
export function colHead(t, cols, { pl = T.sp.md, pr = T.sp.md } = {}) {
  return h_flex().h(T.h.rowDense - 4).pl(pl).pr(pr).gap(T.sp.lg).items_center().border_b_1().border_color(t.border)
    .children(cols.map(([label, w, right]) => {
      let el = div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim);
      el = w === "grow" ? el.flex_1() : el.flex_none().w(w);
      if (right) el = el.text_right();
      return el.child(label);
    }));
}
