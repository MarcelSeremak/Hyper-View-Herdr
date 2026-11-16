// Diffs in the task workspace.
// 1) Merge/pull request review: changed files, a diff viewer, Approve / Request changes.
//    Data: hp mr show <url> --json (demo mode: DEMO_MRS, hp is never called). After a verdict the task's
//    agent gets a message (hp say) and the task a history entry (hp mr ... --task).
// 2) Task worktree diff (Conductor / Codex review pane style): hp worktree diff <id> --json, scope "all"
//    (branch vs default branch, uncommitted work included) or "uncommitted" (the agent's current turn).
//    Click a diff line to comment: the agent gets "Comment on <file>:<line>: ..." (hp say --task) and the
//    task keeps it as a note (hp task note), so the comment shows inline again later.
import { skeleton, kbd, hoverAction, relTime } from "./ide.js";
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { hp, toast, demo, button, iconButton, iconEl, arr, clear, OK, BAD, INFO, WARN } from "./lib.js";
import { DEMO_MRS, DEMO_PROJECT } from "./demo.js";

const STEP = 400;     // diff lines shown at once
const R = {};         // review key -> state
let openKey = null;
const keyOf = (p, x, l) => `${p.slug}/${x.id}|${l.url}`;
export const isReviewable = (l) => l.kind === "mr" || l.kind === "pr";

function load(cx, k, p, l) {
  const old = R[k];
  const s = (R[k] = { loading: true, data: null, err: "", sel: 0, limit: STEP, asking: false, input: null, busy: false, verdict: null, fh: old?.fh ?? null, sh: old?.sh ?? null });
  if (demo()) {
    const d = DEMO_MRS[l.url];
    s.loading = false;
    if (d) s.data = d; else s.err = "No demo data for this link.";
    return;
  }
  cx.spawn(async (cx) => {
    const r = await hp(["mr", "show", l.url], { p: p.slug, as: "ty", json: true }, 90000);
    if (r.ok) { try { s.data = JSON.parse(r.out); } catch { s.err = "hp mr show returned something unexpected."; } }
    else s.err = r.err || "Could not load the changes.";
    s.loading = false;
    cx.notify();
  });
}

// Dev bridge preview only (demo data): open the review of a link, or (wt: true) a worktree diff with an
// inline comment box at { file index sel, line }, without a click.
export function devOpenReview({ slug, id, url, sel = 0, asking = false, wt = false, line = null }) {
  if (!demo()) return;
  if (wt) {
    const x = DEMO_PROJECT.tasks.find((y) => String(y.id) === String(id)) ?? { id, worktree: { branch: `task/${id}`, path: "demo" } };
    const s = wtLoad(null, { slug }, x);
    s.sel = sel;
    if (line != null) {
      const ls = numbered(String(arr(s.data?.files)[sel]?.diff ?? "").split("\n"));
      const j = Math.max(0, ls.findIndex((d) => d.no === line && !d.del));
      s.at = { file: arr(s.data?.files)[sel]?.path, line, j };
      s.ctx = { host: null, p: { slug }, x };
      wtInput(`${slug}/${id}`);
    }
    return;
  }
  const k = `${slug}/${id}|${url}`;
  openKey = k;
  load(null, k, { slug }, { url });
  Object.assign(R[k], { sel, asking });
  if (asking) commentInput({}, R[k], { slug }, { id }, { url });
}

export function reviewButton(t, p, x, l, i) {
  const k = keyOf(p, x, l);
  const on = openKey === k;
  return button(t, `mp-tp-rv-${i}`, on ? "Hide" : "Review", (_e, cx) => {
    openKey = on ? null : k;
    if (!on && (!R[k] || R[k].err)) load(cx, k, p, l);
    cx.notify();
  }, { small: true, ghost: !on });
}

async function decide(host, cx, s, p, x, l, approve, text) {
  const label = l.kind === "pr" ? "PR" : "MR";
  const msg = approve ? `${label} approved` : `Changes requested: ${text}`;
  s.busy = true;
  cx.notify();
  if (demo()) {
    s.busy = false; s.asking = false; s.verdict = approve ? "approved" : "changes";
    toast(approve ? `${label} approved` : "Changes requested", "Demo mode: nothing was sent.", "success");
    cx.notify();
    return;
  }
  const r = await hp(["mr", approve ? "approve" : "comment", l.url, ...(approve ? [] : [text])], { p: p.slug, as: "ty", task: String(x.id) }, 90000);
  if (!r.ok) { s.busy = false; toast("Review not sent", r.err, "error"); cx.notify(); return; }
  if (x.agent) {
    const r2 = await hp(["say", `${msg} (${l.url})`], { p: p.slug, as: "ty", to: x.agent, task: String(x.id) });
    if (!r2.ok) toast(`${x.agent} was not told`, r2.err, "warning");
  }
  s.busy = false; s.asking = false; s.verdict = approve ? "approved" : "changes";
  toast(approve ? `${label} approved` : "Changes requested", l.title || l.url, "success");
  host.reload?.(cx);
  cx.notify();
}

function commentInput(host, s, p, x, l) {
  if (!s.input) {
    s.input = InputState.new({ placeholder: "What should change?" });
    s.input.on("submit", (_e, cx) => send(host, cx, s, p, x, l));
  }
  return s.input;
}
function send(host, cx, s, p, x, l) {
  const text = s.input?.value().trim();
  if (!text || s.busy) return;
  cx.spawn(async (cx) => decide(host, cx, s, p, x, l, false, text));
}

// Unified diff lines with the line number they refer to (new side; old side for deletions).
function numbered(lines) {
  let o = 0, n = 0;
  return lines.map((ln) => {
    if (ln.startsWith("@@")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { o = Number(m[1]); n = Number(m[2]); }
      return { ln, hunk: true, no: null };
    }
    if (ln.startsWith("\\")) return { ln, no: null };
    if (ln.startsWith("+")) return { ln, add: true, no: n++ };
    if (ln.startsWith("-")) return { ln, del: true, no: o++ };
    o++;
    return { ln, no: n++ };
  });
}

// ------------------------------------------------------------ diff viewer
// Patterns: GitHub "Files changed" (Viewed checkbox collapses the file, comment threads under the line,
// Enter / Shift+Enter / Esc in the comment box), GitLab MR shortcuts (j/k or ]/[ files, n/p next/previous),
// Zed / VS Code (soft wrap toggle, "next change"), Codex review pane (one file at a time, compact list).
// Wrap and "viewed" are kept per process (globalThis), so a refresh or a reload of the diff keeps them.
// A viewed file counts as viewed until its diff changes (GitHub resets "Viewed" when the file changes).
const PREF = (globalThis.__hvDiffPref ??= { wrap: true, viewed: {} });
const sig = (f) => `${String(f?.diff ?? "").length}:${f?.additions ?? 0}:${f?.deletions ?? 0}`;
const isViewed = (vk, f) => Boolean(f) && PREF.viewed[vk]?.[f.path] === sig(f);
function setViewed(vk, f, on) { const m = (PREF.viewed[vk] ??= {}); if (on) m[f.path] = sig(f); else delete m[f.path]; }
// Focus handle (keys) and scroll handle (hunk navigation) are made in handlers, never during render.
function ensure(s, cx) {
  if (!s.fh) { try { s.fh = cx.focus_handle(); } catch {} }
  if (!s.sh) { try { s.sh = ScrollHandle.new(); } catch {} }
}
const grab = (s, cx) => { ensure(s, cx); try { s.fh?.focus(); } catch {} };
// File list order: files to review first, viewed ones after (collapsed, GitHub style).
const order = (files, vk) => [...files.keys()].sort((a, b) => Number(isViewed(vk, files[a])) - Number(isViewed(vk, files[b])) || a - b);
function pickFile(s, i, cx, ix) {
  if (i == null || i < 0) return;
  if (s.sel !== i) { s.sel = i; s.limit = STEP; s.hunk = null; s.peek = null; if (ix?.at) ix.cancel(cx); }
  s.wantScroll = true;
}
// n / ]: next change (hunk); past the last one, the first change of the next file still to review.
function goHunk(s, files, vk, dir, cx, ix) {
  const n = s.hunkN ?? 0;
  const h = s.hunk == null ? (dir > 0 ? 0 : n - 1) : s.hunk + dir;
  if (h >= 0 && h < n) { s.hunk = h; s.wantScroll = true; return; }
  const ord = order(files, vk).filter((i) => !isViewed(vk, files[i]) || i === s.sel);
  const pos = ord.indexOf(Math.min(s.sel, files.length - 1));
  const next = ord[pos + dir];
  if (next == null) { s.hunk = n ? Math.max(0, Math.min(n - 1, h)) : null; s.wantScroll = true; return; }
  pickFile(s, next, cx, ix);
  s.hunk = dir > 0 ? 0 : "last";
}
function toggleViewed(s, files, vk, i, cx, ix) {
  const y = files[i];
  if (!y) return;
  const on = !isViewed(vk, y);
  setViewed(vk, y, on);
  if (s.peek === y.path) s.peek = null;
  // Marked viewed: on to the next file still to review (GitHub moves focus to the next file).
  if (on && i === s.sel) {
    const rest = order(files, vk).filter((j) => !isViewed(vk, files[j]));
    const next = rest.find((j) => j > i) ?? rest[0];
    if (next != null) pickFile(s, next, cx, ix);
  }
}
function diffKey(e, cx, s, files, vk, ix) {
  if (!s.fh?.is_focused() || !files.length) return; // typing in the comment box
  const m = e.modifiers ?? {};
  if (m.control || m.alt || m.platform) return;
  const k = e.key;
  const ord = order(files, vk);
  const pos = ord.indexOf(Math.min(s.sel, files.length - 1));
  if (k === "j" || k === "down") pickFile(s, ord[Math.min(ord.length - 1, pos + 1)], cx, ix);
  else if (k === "k" || k === "up") pickFile(s, ord[Math.max(0, pos - 1)], cx, ix);
  else if (k === "n" || k === "]") goHunk(s, files, vk, 1, cx, ix);
  else if (k === "p" || k === "[") goHunk(s, files, vk, -1, cx, ix);
  else if (k === "w") PREF.wrap = !PREF.wrap;
  else if (k === "v") toggleViewed(s, files, vk, Math.min(s.sel, files.length - 1), cx, ix);
  else return;
  cx.stop_propagation();
  cx.notify();
}

// Diff split into blocks (the scroll area's direct children, so hunks can be scrolled to): a code block
// starts at every hunk header, and every line with comments or the open comment box ends one, so a thread
// renders full width under its line, outside the sideways scroll of the code.
function blocks(shown, f, notes, ix) {
  const out = [], hunks = [];
  let cur = null;
  shown.forEach((d, j) => {
    if (d.hunk || !cur) { cur = { rows: [] }; if (d.hunk) hunks.push(out.length); out.push(cur); }
    cur.rows.push([d, j]);
    const here = d.no != null && !d.del ? notes.filter((c) => c.line === d.no) : [];
    const at = Boolean(ix?.at && ix.at.file === f.path && ix.at.j === j);
    if (here.length || at) { out.push({ thread: true, d, j, here, at }); cur = null; }
  });
  return { out, hunks };
}

const checkBox = (t, id, on, fn, tip) => h_flex().id(id).flex_none().size(14).items_center().justify_center().rounded(T.r.chip).cursor_pointer()
  .border_1().border_color(on ? OK : t.input).bg(on ? `${OK}26` : clear).hover((st) => st.border_color(OK)).tooltip(tip)
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
  .when(on, (e) => e.child(iconEl("check", OK, 10)));
// Two-state ghost chip (Wrap): label + check when on, key hint.
const toggleChip = (t, id, label, on, fn, key, tip) => h_flex().id(id).flex_none().h(22).pl(T.sp.md).pr(T.sp.xs).gap(T.sp.sm).rounded(T.r.ctrl).items_center().cursor_pointer()
  .text_size(T.text.xs).font_medium().text_color(on ? t.foreground : t.muted).bg(on ? t.raised : clear).hover((st) => st.bg(t.hover))
  .tooltip(tip)
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); })
  .child(label).child(kbd(t, key));

// File list (+/−) and the diff of the selected file. Shared by the MR review and the worktree diff.
// s: { sel, limit, hunk, peek, showViewed, fh, sh }. vk: key the "viewed" marks are kept under.
// ix (optional, worktree only): inline comments { comments, at, input, pick, send, cancel }.
function diffView(t, s, files, idp, ix, vk) {
  const sel = Math.min(s.sel, files.length - 1);
  const f = files[sel];
  const wrap = PREF.wrap;
  const lines = f ? numbered(String(f.diff ?? "").replace(/\n$/, "").split("\n")) : [];
  const shown = lines.slice(0, s.limit);
  const notes = ix && f ? arr(ix.comments).filter((c) => c.file === f.path) : [];
  const nViewed = files.filter((y) => isViewed(vk, y)).length;
  const viewed = isViewed(vk, f);
  const collapsed = viewed && s.peek !== f?.path;
  const { out, hunks } = f && f.diff && !collapsed ? blocks(shown, f, notes, ix) : { out: [], hunks: [] };
  s.hunkN = hunks.length;
  if (s.hunk === "last") s.hunk = hunks.length ? hunks.length - 1 : null;
  if (s.hunk != null && s.hunk >= hunks.length) s.hunk = hunks.length ? hunks.length - 1 : null;
  if (s.wantScroll && s.sh) { try { s.sh.scroll_to_item(s.hunk != null ? hunks[s.hunk] : 0); } catch {} s.wantScroll = false; }
  const curJ = s.hunk != null ? out[hunks[s.hunk]]?.rows[0]?.[1] : null;
  const act = (fn) => (cx) => { grab(s, cx); fn(cx); };

  // Toolbar: viewed progress (keys in its tooltip), Wrap, previous / next change.
  const tools = h_flex().h(T.h.rowDense).px(8).gap(4).items_center().border_t_1().border_color(t.border)
    .child(div().id(`${idp}-keys`).flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim)
      .tooltip(`${ix ? "Click a line to comment. " : ""}Keys (click the diff first): j/k or ↑↓ files · n/p or ]/[ changes · w wrap · v viewed`)
      .child(`${nViewed}/${files.length} viewed`))
    .child(toggleChip(t, `${idp}-wrap`, "Wrap", wrap, act(() => { PREF.wrap = !PREF.wrap; }), "w", wrap ? "Long lines wrap (W: scroll sideways instead)" : "Long lines scroll sideways (W: wrap them)"))
    .child(iconButton(t, `${idp}-prev`, "chevron-left", (_e, cx) => { grab(s, cx); goHunk(s, files, vk, -1, cx, ix); cx.notify(); }, "Previous change (p or [)", { size: 22 }))
    .child(hoverAction(t, `${idp}-next`, "Next change", (cx) => { grab(s, cx); goHunk(s, files, vk, 1, cx, ix); }, "n"));

  const fileRow = (j) => {
    const y = files[j], on = j === sel, v = isViewed(vk, y);
    return h_flex().id(`${idp}-f-${j}`).h(T.h.rowDense).mx(4).px(8).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
      .bg(on ? t.hover : clear).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { grab(s, cx); pickFile(s, j, cx, ix); cx.notify(); })
      .child(checkBox(t, `${idp}-fv-${j}`, v, act((cx) => toggleViewed(s, files, vk, j, cx, ix)), v ? "Viewed (V to unmark)" : "Mark as viewed (V)"))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(on ? t.foreground : v ? t.dim : t.muted).child(y.path))
      .when(Boolean(y.status) && y.status !== "modified", (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(y.status === "untracked" ? WARN : t.dim).child(y.status)))
      .child(div().flex_none().text_size(T.text.xs).text_color(v ? t.dim : OK).child(`+${y.additions ?? 0}`))
      .child(div().flex_none().w(34).text_right().text_size(T.text.xs).text_color(v ? t.dim : BAD).child(`−${y.deletions ?? 0}`));
  };
  const ord = order(files, vk);
  const showViewed = s.showViewed || viewed;
  const fileList = v_flex().py(4).border_t_1().border_color(t.border)
    .when(files.length === 0, (el) => el.child(div().px(12).py(6).text_size(T.text.xs).text_color(t.dim).child("No changed files.")))
    .children(ord.filter((j) => !isViewed(vk, files[j])).map(fileRow))
    .when(nViewed > 0, (el) => el.child(h_flex().id(`${idp}-vgrp`).h(24).mx(4).px(8).gap(6).items_center().rounded(T.r.ctrl).cursor_pointer()
      .hover((st) => st.bg(t.hover)).text_size(T.text.xs).text_color(t.dim)
      .on_click((_e, cx) => { s.showViewed = !showViewed; cx.notify(); })
      .child(iconEl(showViewed ? "chevron-down" : "chevron-right", t.dim, 11))
      .child(`Viewed ${nViewed}`))
      .when(showViewed, (e) => e.children(ord.filter((j) => isViewed(vk, files[j])).map(fileRow))));

  const codeRow = (d, j) => {
    const at = ix?.at && ix.at.file === f.path && ix.at.j === j;
    const cur = d.hunk && j === curJ;
    const bg = d.add ? `${OK}24` : d.del ? `${BAD}24` : d.hunk ? `${INFO}${cur ? "33" : "14"}` : clear;
    const text = d.ln.length ? d.ln : " ";
    let el = h_flex().id(`${idp}-l-${j}`).items_start().min_h(17).bg(at ? `${t.accent.slice(0, 7)}33` : bg)
      .border_l_2().border_color(cur ? t.accent : clear)
      .child(div().flex_none().w(38).pr(6).text_right().text_color(t.dim).child(d.no == null ? " " : String(d.no)))
      .child((wrap ? div().flex_1().min_w(0).whitespace_normal() : div().flex_none().whitespace_nowrap()).pr(12)
        .text_color(d.hunk ? t.dim : d.add ? OK : d.del ? BAD : t.foreground).child(text));
    if (ix && d.no != null) el = el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => ix.pick(f.path, d.no, j, cx));
    return el;
  };
  const codeBlock = (b, bi) => {
    const rows = v_flex().min_w_full().children(b.rows.map(([d, j]) => codeRow(d, j)));
    return wrap ? rows.w_full() : div().id(`${idp}-seg-${bi}`).w_full().overflow_x_scrollbar().child(rows);
  };
  // A comment thread under its line (full width), with the composer when this is the clicked line.
  const thread = (b) => v_flex().id(`${idp}-th-${b.j}`).mx(8).my(4).rounded(T.r.panel).border_1().border_color(b.at ? t.accent : t.border)
    .bg(t.surface).overflow_hidden().font_family("JetBrains Mono")
    .children(b.here.map((c, k) => v_flex().px(8).py(6).gap(2).when(k > 0, (e) => e.border_t_1().border_color(t.border))
      .child(h_flex().gap(6).items_center()
        .child(iconEl("messages", c.by === "ty" ? t.accent : t.muted, 11))
        .child(div().text_size(T.text.xs).font_medium().text_color(t.foreground).child(c.by === "ty" ? "You" : c.by ?? "agent"))
        .when(Boolean(c.ts), (e) => e.child(relTime(t, `${idp}-th-${b.j}-ts-${k}`, c.ts))))
      .child(div().text_size(T.text.sm).line_height(`${T.lh.sm}px`).whitespace_normal().text_color(t.foreground).child(c.text))))
    .when(!b.at && Boolean(ix), (el) => el.child(h_flex().id(`${idp}-th-${b.j}-re`).h(26).px(8).gap(6).items_center().cursor_pointer()
      .border_t_1().border_color(t.border).text_size(T.text.xs).text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => ix.pick(f.path, b.d.no, b.j, cx))
      .child("Reply…")))
    .when(b.at && Boolean(ix?.input), (el) => el.child(v_flex().px(8).py(8).gap(6).when(b.here.length > 0, (e) => e.border_t_1().border_color(t.border))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // keep the focus in the comment box
      .on_key_down((e, cx) => {
        if (e.key === "enter" && !e.modifiers?.shift) { cx.stop_propagation(); ix.send(cx); }
        else if (e.key === "escape") { cx.stop_propagation(); ix.cancel(cx); grab(s, cx); }
      })
      .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(`Comment on ${f.path}:${b.d.no} for the agent`))
      .child(Textarea.new(ix.input).w_full().px(8).py(6).rounded(T.r.ctrl).border_1().border_color(t.accent).bg(t.background)
        .text_size(T.text.sm).text_color(t.foreground))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child("Enter send · Shift+Enter newline · Esc cancel"))
        .child(button(t, `${idp}-cx`, "Cancel", (_e, cx) => { ix.cancel(cx); grab(s, cx); }, { small: true, ghost: true }))
        .child(button(t, `${idp}-csend`, "Comment", (_e, cx) => ix.send(cx), { small: true, primary: true })))));

  const viewer = !f ? null : v_flex().border_t_1().border_color(t.border)
    .child(h_flex().h(T.h.rowDense).px(12).gap(8).items_center().text_size(T.text.xs).text_color(t.muted)
      .child(checkBox(t, `${idp}-viewed`, viewed, act((cx) => toggleViewed(s, files, vk, sel, cx, ix)), viewed ? "Viewed (V to unmark)" : "Mark as viewed (V): collapses the file"))
      .child(div().flex_1().min_w(0).truncate().text_color(viewed ? t.dim : t.foreground).child(f.path))
      .when(hunks.length > 0, (el) => el.child(div().flex_none().text_color(t.dim)
        .child(s.hunk != null ? `Change ${s.hunk + 1} of ${hunks.length}` : `${hunks.length} change${hunks.length === 1 ? "" : "s"}`)))
      .when(Boolean(ix) && Boolean(f.diff) && !collapsed && hunks.length === 0, (el) => el.child(div().flex_none().text_color(t.dim).child("Click a line to comment"))))
    .when(collapsed, (el) => el.child(h_flex().id(`${idp}-peek`).h(T.h.rowDense).px(12).gap(6).items_center().cursor_pointer()
      .text_size(T.text.xs).text_color(t.dim).hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => { s.peek = f.path; cx.notify(); })
      .child(iconEl("check", OK, 11)).child("Viewed · show the diff")))
    .when(!collapsed, (el) => el.child(f.diff
      ? v_flex().id(`${idp}-diff`).w_full().max_h(560).overflow_y_scrollbar().pb(6)
        .when(Boolean(s.sh), (e) => e.track_scroll(s.sh))
        .font_family("JetBrains Mono").text_size(T.text.xs).line_height(1.45)
        .children(out.map((b, bi) => (b.thread ? thread(b) : codeBlock(b, bi))))
      : div().px(12).pb(12).text_size(T.text.xs).text_color(t.dim).child(f.status === "untracked" ? "New file, not added to git yet (no diff until the agent stages or commits it)." : "No text diff (binary, renamed only, or too large).")))
    .when(Boolean(f.truncated) && !collapsed, (el) => el.child(div().px(12).pb(6).text_size(T.text.xs).text_color(WARN).child("Diff truncated (very large file).")))
    .when(lines.length > shown.length && !collapsed, (el) => el.child(h_flex().id(`${idp}-more`).h(T.h.rowDense).px(12).items_center().cursor_pointer()
      .border_t_1().border_color(t.border).text_size(T.text.xs).text_color(t.accent)
      .on_click((_e, cx) => { s.limit += STEP; cx.notify(); })
      .child(`Show more (${lines.length - shown.length} more lines)`)));
  return v_flex().id(`${idp}-dv`)
    .when(Boolean(s.fh), (el) => el.track_focus(s.fh))
    .on_mouse_down("left", (_e, cx) => { if (!s.fh) { grab(s, cx); cx.notify(); } else grab(s, cx); })
    .on_key_down((e, cx) => diffKey(e, cx, s, files, vk, ix))
    .when(files.length > 0, (el) => el.child(tools))
    .child(fileList).when(Boolean(viewer), (el) => el.child(viewer));
}

// The expanded review under the link row (null when closed).
export function reviewPanel(host, t, p, x, l, i) {
  const k = keyOf(p, x, l);
  if (openKey !== k) return null;
  const s = R[k];
  const box = v_flex().id(`mp-rv-${i}`).mx(6).mb(6).rounded(T.r.panel).border_1().border_color(t.border).bg(t.background).overflow_hidden();
  if (!s || s.loading) return box.child(div().py(T.sp.sm).child(skeleton(t, 4, { avatar: false, h: T.h.rowDense })));
  if (s.err) {
    return box.child(v_flex().px(12).py(12).gap(8)
      .child(div().text_size(T.text.xs).line_height(1.45).text_color(BAD).whitespace_normal().child(s.err))
      .child(h_flex().child(button(t, `mp-rv-retry-${i}`, "Try again", (_e, cx) => { load(cx, k, p, l); cx.notify(); }, { small: true }))));
  }
  const d = s.data ?? {};
  const files = arr(d.files);
  const sum = (key) => files.reduce((a, y) => a + (Number(y[key]) || 0), 0);
  const verdict = s.verdict === "approved" ? ["Approved", OK] : s.verdict === "changes" ? ["Changes requested", BAD] : null;

  const head = v_flex().px(12).pt(12).pb(8).gap(4)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).font_semibold().child(d.title || l.title || l.url))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.muted).child(d.state ?? "")))
    .child(h_flex().gap(8).items_center().text_size(T.text.xs)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([d.author, d.source && d.target ? `${d.source} → ${d.target}` : ""].filter(Boolean).join(" · ")))
      .child(div().flex_none().text_color(OK).child(`+${sum("additions")}`))
      .child(div().flex_none().text_color(BAD).child(`−${sum("deletions")}`)));

  const actions = s.asking && s.input   // the input is created in the click handler (not allowed during render)
    ? h_flex().px(12).py(8).gap(6).items_center().border_t_1().border_color(t.border)
      .child(h_flex().flex_1().min_w(0).h(28).px(8).items_center().rounded(T.r.ctrl).border_1().border_color(t.input).bg(t.surface)
        .child(Input.new(s.input).flex_1().h(26).text_size(T.text.sm).text_color(t.foreground)))
      .child(iconButton(t, `mp-rv-send-${i}`, "send", (_e, cx) => send(host, cx, s, p, x, l), "Send", { size: 28, color: t.accent }))
      .child(iconButton(t, `mp-rv-x-${i}`, "x", (_e, cx) => { s.asking = false; cx.notify(); }, "Cancel", { size: 28 }))
    : h_flex().px(12).py(8).gap(6).items_center().border_t_1().border_color(t.border)
      .when(Boolean(verdict), (el) => el.child(div().flex_1().text_size(T.text.xs).font_medium().text_color(verdict[1]).child(verdict[0])))
      .when(!verdict, (el) => el.child(div().flex_1().text_size(T.text.xs).text_color(t.dim).child(s.busy ? "Sending…" : `${files.length} file${files.length === 1 ? "" : "s"}`)))
      .child(button(t, `mp-rv-ch-${i}`, "Request changes", (_e, cx) => {
        if (s.busy) return;
        s.asking = true;
        const inp = commentInput(host, s, p, x, l); inp.set_value(""); inp.focus();
        cx.notify();
      }, { small: true, danger: true }))
      .child(button(t, `mp-rv-ok-${i}`, "Approve", (_e, cx) => { if (!s.busy) cx.spawn(async (cx) => decide(host, cx, s, p, x, l, true)); }, { small: true, primary: true, iconName: "check" }));

  return box.child(head).child(diffView(t, s, files, `mp-rv-${i}`, null, k)).child(actions);
}

// ------------------------------------------------------------ task worktree diff
const W = {};         // "<slug>/<task id>" -> worktree diff state
const wkey = (p, x) => `${p.slug}/${x.id}`;
export const wtState = (p, x) => W[wkey(p, x)] ?? null;

// Demo mode: a small believable diff per task (hp is never called).
function demoDiff(x, scope) {
  const slug = String(x.worktree?.branch ?? `task/${x.id}`).split("/").pop().replace(/^\d+-/, "") || "change";
  const file = (path, status, diff) => {
    const ls = diff.split("\n");
    return { path, status, diff, additions: ls.filter((l) => l.startsWith("+")).length, deletions: ls.filter((l) => l.startsWith("-")).length };
  };
  const files = [
    file(`src/${slug}.ts`, "added", `@@ -0,0 +1,9 @@\n+// Task #${x.id}: ${slug.replace(/-/g, " ")}\n+import { config } from "./config";\n+\n+export async function run(env = config.env) {\n+  const started = Date.now();\n+  await config.client.ping();\n+  console.log(\`${slug} ok in \${Date.now() - started} ms\`);\n+  return true;\n+}`),
    file("src/config.ts", "modified", "@@ -4,9 +4,11 @@ export const config = {\n   env: process.env.NODE_ENV ?? \"development\",\n-  timeoutMs: 5000,\n+  timeoutMs: 15000,\n+  retries: 3,\n   client: createClient({\n     url: process.env.API_URL,\n-    pool: 4,\n+    pool: 8,\n+    keepAlive: true,\n   }),\n };"),
    file("tests/smoke.spec.ts", "modified", `@@ -12,4 +12,9 @@ describe("smoke", () => {\n   it("starts", async () => {\n     expect(await boot()).toBe(true);\n   });\n+\n+  it("${slug} runs", async () => {\n+    const { run } = await import("../src/${slug}");\n+    expect(await run("test")).toBe(true);\n+  });\n });`),
    file("notes/scratch.md", "untracked", ""),
  ];
  const pruned = Boolean(x.worktree?.pruned);
  return {
    branch: x.worktree?.branch ?? "", target: "main", base: "4e1c0a7", ahead: 3, behind: 0, dirty: pruned ? 0 : 2,
    pruned, merged: x.worktree?.merged ?? "", scope,
    files: scope === "uncommitted" ? (pruned ? [] : files.slice(1, 2).concat(files.slice(3))) : pruned ? files.slice(0, 3) : files,
  };
}

export function wtLoad(cx, p, x, scope) {
  const k = wkey(p, x), old = W[k];
  const s = (W[k] = { loading: true, data: null, err: "", sel: 0, limit: STEP, scope: scope ?? old?.scope ?? "all", at: null, input: WI[k] ?? null, ctx: null, local: old?.local ?? [], busy: false, fh: old?.fh ?? null, sh: old?.sh ?? null, showViewed: old?.showViewed ?? false });
  if (demo()) { s.loading = false; s.data = demoDiff(x, s.scope); return s; }
  cx.spawn(async (cx) => {
    const r = await hp(["worktree", "diff", String(x.id)], { p: p.slug, as: "ty", json: true, scope: s.scope === "uncommitted" ? "uncommitted" : undefined }, 90000);
    if (r.ok) { try { s.data = JSON.parse(r.out); } catch { s.err = "hp worktree diff returned something unexpected."; } }
    else s.err = r.err || "Could not load the worktree diff.";
    s.loading = false;
    cx.notify();
  });
  return s;
}

// One comment input per task, bound once; it sends with the task's current state (s.ctx is set on pick).
const WI = {};
function wtInput(k) {
  if (!WI[k]) {
    // Multi-line (Shift+Enter newline); Enter sends via the composer's key handler (diffView).
    WI[k] = TextareaState.new({ placeholder: "Comment for the agent…", rows: 2 });
    try { WI[k].set_auto_grow(2, 8); } catch {}
    WI[k].on("submit", (e, cx) => { const s = W[k]; if (s?.ctx && !e?.shift) wtSend(s.ctx.host, cx, s, s.ctx.p, s.ctx.x); });
  }
  if (W[k]) W[k].input = WI[k];
  return WI[k];
}
function wtSend(host, cx, s, p, x) {
  const text = s.input?.value().trim();
  if (!text || s.busy || !s.at) return;
  const { file, line } = s.at;
  const msg = `Comment on ${file}:${line}: ${text}`;
  s.busy = true;
  cx.spawn(async (cx) => {
    if (demo()) toast("Comment sent", "Demo mode: nothing was sent.", "success");
    else {
      const r = await hp(["say", msg], { p: p.slug, as: "ty", to: x.agent || "all", task: String(x.id) });
      if (!r.ok) { s.busy = false; toast("Comment not sent", r.err, "error"); cx.notify(); return; }
      const r2 = await hp(["task", "note", String(x.id), msg], { p: p.slug, as: "ty" });
      if (!r2.ok) toast("Not saved as a task note", r2.err, "warning");
      toast("Comment sent", `${x.agent || "the team"} · ${file}:${line}`, "success");
    }
    s.local.push({ file, line, text, by: "ty", ts: new Date().toISOString() });
    s.busy = false; s.at = null;
    s.input?.set_value("");
    try { s.fh?.focus(); } catch {} // back to the diff keys (n / p / j / k)
    host?.reload?.(cx);
    cx.notify();
  });
}

// Comments already on the task (notes "Comment on <file>:<line>: ...") plus ones sent in this session.
function wtComments(s, x) {
  const out = [];
  for (const n of arr(x.notes)) {
    const m = String(n.text ?? "").match(/^Comment on (.+?):(\d+): ([\s\S]*)$/);
    if (m) out.push({ file: m[1], line: Number(m[2]), text: m[3], by: n.by, ts: n.ts });
  }
  for (const c of s.local) if (!out.some((o) => o.file === c.file && o.line === c.line && o.text === c.text)) out.push(c);
  return out;
}

// Changes tab, worktree part: branch → target, ahead/behind/uncommitted, scope switch, files and diff.
export function worktreeDiff(host, t, p, x) {
  const w = x.worktree;
  const s = W[wkey(p, x)];
  const box = v_flex().id("mp-wt-box").rounded(T.r.panel).border_1().border_color(t.border).bg(t.background).overflow_hidden();
  const d = s?.data;
  const scopeSeg = h_flex().flex_none().h(24).p(2).gap(2).rounded(T.r.ctrl).bg(t.raised)
    .children([["all", "All changes"], ["uncommitted", "Last turn"]].map(([k, label]) => h_flex().id(`mp-wt-scope-${k}`).h(20).px(6).items_center().rounded(T.r.chip).cursor_pointer()
      .bg((s?.scope ?? "all") === k ? t.surface : clear).text_size(T.text.xs).text_color((s?.scope ?? "all") === k ? t.foreground : t.muted)
      .tooltip(k === "all" ? `Everything on ${w.branch} since it left the default branch, uncommitted work included` : "Only what is not committed yet: the agent's current turn")
      .on_click((_e, cx) => { if ((s?.scope ?? "all") !== k) wtLoad(cx, p, x, k); cx.notify(); })
      .child(label)));
  const files = arr(d?.files);
  const sum = (key) => files.reduce((a, y) => a + (Number(y[key]) || 0), 0);
  const facts = d ? [
    `${d.ahead ?? 0} commit${d.ahead === 1 ? "" : "s"} ahead`,
    d.behind ? `${d.behind} behind` : "",
    d.dirty ? `${d.dirty} uncommitted` : "",
  ].filter(Boolean).join(" · ") : "";
  const head = v_flex().px(12).pt(8).pb(8).gap(4)
    .child(h_flex().gap(6).items_center()
      .child(iconEl("git-branch", t.muted, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).font_medium().child(`${w.branch} → ${d?.target ?? "main"}`))
      .child(scopeSeg)
      .child(iconButton(t, "mp-wt-refresh", "loop", (_e, cx) => { wtLoad(cx, p, x); cx.notify(); }, "Refresh", { size: 24 })))
    .child(h_flex().gap(8).items_center().text_size(T.text.xs)
      .child(div().flex_1().min_w(0).truncate().text_color(d?.dirty ? WARN : t.dim)
        .child(w.merged ? `Merged into ${d?.target ?? "main"}${w.merge_sha ? ` (${w.merge_sha})` : ""}` : w.pruned ? `Worktree removed · branch kept${facts ? ` · ${facts}` : ""}` : facts || (s?.loading ? "Reading the worktree…" : "")))
      .when(files.length > 0, (el) => el.child(div().flex_none().text_color(OK).child(`+${sum("additions")}`)).child(div().flex_none().text_color(BAD).child(`−${sum("deletions")}`))));
  if (!s || s.loading) return box.child(head).child(s ? div().pb(T.sp.sm).child(skeleton(t, 4, { avatar: false, h: T.h.rowDense })) : div().px(12).pb(12).text_size(T.text.xs).text_color(t.dim).child("Not loaded yet."));
  if (s.err) {
    return box.child(head).child(v_flex().px(12).pb(12).gap(8)
      .child(div().text_size(T.text.xs).line_height(1.45).text_color(BAD).whitespace_normal().child(s.err))
      .child(h_flex().child(button(t, "mp-wt-retry", "Try again", (_e, cx) => { wtLoad(cx, p, x); cx.notify(); }, { small: true }))));
  }
  const ix = {
    comments: wtComments(s, x),
    at: s.at,
    input: s.input,
    pick: (file, line, j, cx) => {
      s.at = { file, line, j };
      s.ctx = { host, p, x };
      const inp = wtInput(wkey(p, x)); inp.set_value(""); inp.focus();
      cx.notify();
    },
    send: (cx) => wtSend(host, cx, s, p, x),
    cancel: (cx) => { s.at = null; cx.notify(); },
  };
  return box.child(head).child(diffView(t, s, files, "mp-wt", ix, wkey(p, x)))
    .when(files.length === 0 && s.scope === "uncommitted", (el) => el.child(div().px(12).pb(8).text_size(T.text.xs).text_color(t.dim).child("Nothing uncommitted: the last turn was committed.")));
}
