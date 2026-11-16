// Project Activity. Thousands of steps are summarised as runs (activityview.js buildRuns: one row per
// session / task of an agent, with duration, outcome, counts and the last message; expandable to the key
// steps). Two places:
//   - Overview: an "Activity" card with the 5 newest runs and "Open full activity";
//   - the full view (shared mp.view { kind: "project", slug, tab: "activity" }): runs grouped by day with an
//     agent filter, or "Steps": the raw virtual list (grouped by day, the current day pinned while you scroll,
//     filters All / Edits / Commands / Tests / Errors / Messages), optionally narrowed to one run.
// State lives on the Workspace (ws.pa*). Keyboard: j/k move, Enter opens (run: expand; step: its task), 1-6 filters (Steps).
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Popover, v_virtual_list, Scrollbar } from "gpui-base";
import { cardHead, emptyLine, kbd } from "./ide.js";
import { setShared } from "herdr";
import { iconEl, card, clear, fmtTime, colorFor, openTab, agentAvatar, liveAgent, BAD, OK, popFocus, restoreFocus } from "./lib.js";
import { actItems, dayOf, activityError } from "./activity.js";
import { KIND, FILTERS, matches, dayLabel, hpItems, fmtDur, buildRuns, runRow } from "./activityview.js";
import { openTaskPanel } from "./taskpanel.js";

const PAGE = 300;
// Rendered by the virtual list: which row is at the top (the pinned day header follows it).
const S = (globalThis.__hvProjAct ??= { top: 0, topDay: null, shown: null });

// Every item of the project, newest first; each has .a (agent, "ty" for you).
export function projectItems(ws, p) {
  return [...actItems(p.slug, null), ...hpItems(ws.events ?? [], null)].sort((a, b) => b.t - a.t);
}

function state(ws, p) {
  if (ws.paFor !== p.slug) { ws.paFor = p.slug; ws.paFilter = "all"; ws.paAgent = null; ws.paLimit = PAGE; ws.paSel = null; ws.paMode = "runs"; ws.paRun = null; ws.paRunsN = RUNS_PAGE; }
  return { f: ws.paFilter ?? "all", agent: ws.paAgent ?? null, limit: ws.paLimit ?? PAGE, mode: ws.paMode ?? "runs", run: ws.paRun ?? null };
}
const RUNS_PAGE = 40;
// Opens the full Activity view of a project: runs of one agent, or the raw steps of one run.
export function openProjectActivity(ws, slug, { agent = null, run = null } = {}) {
  ws.paFor = slug; ws.paFilter = "all"; ws.paLimit = PAGE; ws.paSel = null; ws.paRunsN = RUNS_PAGE;
  ws.paAgent = agent; ws.paMode = run ? "steps" : "runs"; ws.paRun = run ? { from: run.first, to: run.last, a: run.a, title: run.title } : null;
  setShared("mp.view", { kind: "project", slug, tab: "activity" });
}
// Runs of the project (newest first); agent: only that agent's.
export function projectRuns(ws, p, agent) {
  const runs = buildRuns(projectItems(ws, p), p, (n) => liveAgent(p, n));
  return agent ? runs.filter((r) => r.a === agent) : runs;
}
// Expanded runs (ids) live on the Workspace.
const openSet = (ws) => (ws.runOpen ??= new Set());
export function runList(ws, t, p, runs, { showAgent, idp }) {
  const onTask = (id) => openTaskPanel(p.slug, Number(id) || id);
  const set = openSet(ws);
  const sel = ws.navSelKey?.();
  return runs.map((r) => {
    const toggle = () => { if (set.has(r.id)) set.delete(r.id); else set.add(r.id); };
    const el = runRow(t, r, { showAgent, idp, open: set.has(r.id), sel: sel === `run:${r.id}`, onToggle: toggle, onTask, onAll: (x) => openProjectActivity(ws, p.slug, { run: x }) });
    ws.navPush?.({ key: `run:${r.id}`, open: toggle, keys: { space: toggle } });
    return el;
  });
}

const who = (a) => (a === "ty" ? "you" : a ?? "");

function chips(ws, t, all, f, idp) {
  const errors = all.filter((x) => matches("errors", x)).length;
  return h_flex().id(`${idp}-f`).flex_none().gap(T.sp.xs).items_center().children(FILTERS.map(([k, label], i) =>
    h_flex().id(`${idp}-f-${k}`).h(22).px(T.sp.md).gap(T.sp.xs).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.xs).font_medium()
      .bg(f === k ? t.raised : clear).border_1().border_color(f === k ? t.border : clear)
      .text_color(f === k ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
      .tooltip(`${label} (${i + 1})`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { ws.paFilter = k; ws.paLimit = PAGE; cx.notify(); })
      .child(label)
      .when(k === "errors" && errors > 0, (el) => el.child(div().text_size(T.text.xs).text_color(BAD).child(String(errors))))));
}

// Agent picker: a dropdown with counts (the project may have many agents).
function agentPicker(ws, t, p, all, agent, idp) {
  const counts = new Map();
  for (const x of all) if (x.a) counts.set(x.a, (counts.get(x.a) ?? 0) + 1);
  const names = [...new Set([...p.agents.map((a) => a.name), ...counts.keys()])].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const open = ws.paMenu === idp;
  const pick = (n) => (_e, cx) => { ws.paAgent = n; ws.paLimit = PAGE; ws.paMenu = null; restoreFocus("pa-menu"); cx.notify(); };
  const item = (key, label, n, on, go, lead) => h_flex().id(`${idp}-ag-${key}`).h(T.h.rowDense).mx(T.sp.xs).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
    .text_size(T.text.sm).hover((s) => s.bg(t.hover)).on_click(go)
    .child(lead ?? div().w(0)).child(div().flex_1().min_w(0).truncate().child(label))
    .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(String(n)))
    .child(on ? iconEl("check", t.accent, 12) : div().w(12));
  return Popover.new(`${idp}-ag`).anchor("top_left").open(open)
    .on_open_change((o, cx) => { ws.paMenu = o ? idp : null; popFocus(o, "pa-menu"); cx.notify(); })
    .trigger(h_flex().id(`${idp}-ag-t`).flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
      .bg(t.raised).border_1().border_color(open || agent ? t.accent : t.border).text_size(T.text.sm)
      .child(div().text_color(t.dim).child("Agent")).child(div().max_w(160).truncate().child(agent ? who(agent) : "All")).child(iconEl("chevron-down", t.dim, 11)))
    .content(v_flex().id(`${idp}-ag-l`).w(240).max_h(320).overflow_y_scroll().py(T.sp.xs).mt(T.sp.xs).rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_md()
      .child(item("all", "All agents", all.length, !agent, pick(null)))
      .children(names.map((n) => item(n, who(n), counts.get(n) ?? 0, agent === n, pick(n), n === "ty" ? null : agentAvatar(t, n, liveAgent(p, n), 14)))));
}

// One timeline row (as activityview.timelineRow, plus the agent). Inside the virtual list no handlers or
// tooltips are allowed: clicks go through the list's on_item_click.
function row(t, x, id, sel, interactive, onTask) {
  const [ic, color] = KIND[x.k] ?? KIND.tool;
  const fail = x.x === "fail" || x.k === "error";
  const running = x.x === "run" && Date.now() - x.t < 15 * 60 * 1000;
  let el = h_flex().id(id).h(24).gap(T.sp.md).items_center().rounded(T.r.chip).px(T.sp.xs).when(sel, (e) => e.bg(t.hover));
  if (interactive) el = el.hover((s) => s.bg(t.hover)).tooltip(`${new Date(x.t).toLocaleString()}${x.d ? ` · ${fmtDur(x.d)}` : ""}\n${x.l}`)
    .when(Boolean(x.task && onTask), (e) => e.cursor_pointer().on_click(() => onTask(x.task)));
  return el
    .child(iconEl(ic, fail ? BAD : color, 13))
    .child(h_flex().flex_none().w(124).gap(T.sp.sm).items_center().min_w(0)
      .child(div().flex_none().size(T.dot).rounded_full().bg(x.a === "ty" ? t.dim : colorFor(`agent:${x.a}`)))
      .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(String(who(x.a) ?? ""))))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(fail ? BAD : x.k === "prompt" || x.k === "message" ? t.foreground : t.muted).child(String(x.l ?? "")))
    .when(running, (e) => e.child(h_flex().flex_none().gap(T.sp.xs).items_center()
      .child(div().size(T.dot).rounded_full().bg(OK)).child(div().text_size(T.text.xs).text_color(OK).child("running"))))
    .when(Boolean(x.task), (e) => e.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${x.task}`)))
    .child(div().flex_none().w(52).text_right().text_size(T.text.xs).text_color(t.dim).child(running ? "" : String(fmtDur(x.d) ?? "")))
    .child(div().flex_none().w(36).text_right().text_size(T.text.xs).text_color(t.dim).child(fmtTime(x.t)));
}
const dayHead = (t, id, label, n) => h_flex().id(id).h(24).px(T.sp.xs).gap(T.sp.md).items_center().bg(t.surface).border_b_1().border_color(t.border)
  .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(String(label ?? "")))
  .child(div().text_size(T.text.xs).text_color(t.dim).child(String(n)));

// ------------------------------------------------------------ Overview card
export function activitySection(ws, t, p) {
  const runs = projectRuns(ws, p, null);
  const err = activityError();
  const today = runs.filter((r) => dayOf(r.last) === dayOf(Date.now())).length;
  return card(t, "mp-pa-ov")
    .child(cardHead(t, "Activity", h_flex().id("mp-pa-open").flex_none().gap(T.sp.xs).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { openTab("activity"); cx.notify(); })
      .child(div().text_size(T.text.xs).font_medium().text_color(t.accent).hover((s) => s.opacity(0.8)).child("Open full activity")).child(iconEl("chevron-right", t.accent, 11)),
      runs.length ? `${today} run${today === 1 ? "" : "s"} today` : null))
    .child(v_flex().px(T.sp.xs).pb(T.sp.xs)
      .when(runs.length === 0, (el) => el.child(emptyLine(t, "mp-pa-ov-empty", err ? `No activity yet (${err}).` : "No activity yet.")))
      .children(runList(ws, t, p, runs.slice(0, 5), { showAgent: true, idp: "mp-pa-ov" })));
}

// ------------------------------------------------------------ full view
export function activityView(ws, t, p) {
  const { f, agent, limit, mode, run } = state(ws, p);
  if (mode === "runs") return runsView(ws, t, p, agent);
  const all = projectItems(ws, p);
  const inRun = (x) => !run || (x.a === run.a && x.t >= run.from - 1000 && x.t <= run.to + 1000);
  const mine = all.filter((x) => (!agent || x.a === agent) && inRun(x));
  const list = mine.filter((x) => matches(f, x));
  const shown = list.slice(0, limit);
  // Flat rows for the virtual list: day headers + items (+ "Load more").
  const rows = [];
  const perDay = new Map();
  for (const x of shown) { const d = dayOf(x.t); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
  let last = null;
  shown.forEach((x, i) => {
    const d = dayOf(x.t);
    if (d !== last) { rows.push({ day: d }); last = d; }
    rows.push({ x, i });
  });
  if (list.length > shown.length) rows.push({ more: list.length - shown.length });
  const onTask = (id) => openTaskPanel(p.slug, Number(id) || id);
  // Keyboard rows (no navMark: the virtual list allows no handlers; the highlight is drawn here).
  const selKey = ws.navSelKey?.();
  rows.forEach((r, idx) => { if (r.x) ws.navPush({ key: `pa:${r.i}`, idx, open: () => { if (r.x.task) onTask(r.x.task); } }); });
  ws.navKeys = Object.fromEntries(FILTERS.map(([k], i) => [String(i + 1), () => { ws.paFilter = k; ws.paLimit = PAGE; }]));
  const selIdx = rows.findIndex((r) => r.x && `pa:${r.i}` === selKey);
  if (selIdx >= 0 && selIdx !== ws.paScrolledTo && ws.paScroll) { ws.paScrolledTo = selIdx; try { ws.paScroll.scroll_to_item(selIdx, "center"); } catch {} }
  // Pinned day: the day of the top visible row (S.top / S.topDay come from the list's last layout).
  const dayAt = (i) => { const r = rows[Math.min(i, rows.length - 1)]; return r ? r.day ?? (r.x ? dayOf(r.x.t) : last) : null; };
  const topDay = S.top > 0 ? dayAt(S.top) : null;
  S.shown = topDay;
  const H = Math.max(240, (ws.height ?? 700) - 16 - 24 - 44 - T.h.rowDense - 16);
  const err = activityError();
  let listEl = v_virtual_list("mp-pa-list", rows.length, 24, (i) => (rows[i].day ? `d:${rows[i].day}` : rows[i].more ? "more" : `r:${rows[i].i}`), (range) => {
    S.top = range.start;
    S.topDay = range.start > 0 ? dayAt(range.start) : null;
    const out = [];
    for (let i = range.start; i < range.end; i++) {
      const r = rows[i];
      if (!r) continue;
      if (r.day) out.push(dayHead(t, `mp-pa-d-${r.day}`, dayLabel(r.day), perDay.get(r.day) ?? 0));
      else if (r.more) out.push(h_flex().id("mp-pa-more").h(24).items_center().justify_center().rounded(T.r.chip).border_1().border_color(t.border)
        .child(div().text_size(T.text.xs).text_color(t.accent).child(`Load more (${r.more})`)));
      else out.push(row(t, r.x, `mp-pa-r-${r.i}`, i === selIdx, false));
    }
    return out;
  }).size_full();
  if (ws.paScroll) listEl = listEl.track_scroll(ws.paScroll);
  listEl = listEl.on_item_click((key, cx) => {
      if (key === "more") { ws.paLimit = (ws.paLimit ?? PAGE) + PAGE; cx.notify(); return; }
      if (!key.startsWith("r:")) return;
      const x = shown[Number(key.slice(2))];
      ws.navSelSet?.(`pa:${key.slice(2)}`);
      if (x?.task) onTask(x.task);
      cx.notify();
    });
  return v_flex().gap(T.sp.md)
    .child(toolbar(ws, t, p, "steps", `${list.length}${list.length !== all.length ? ` of ${all.length}` : ""} steps`, all, agent)
      .when(Boolean(run), (el) => el.child(h_flex().id("mp-pa-run").flex_none().max_w(260).h(T.h.btnSm).pl(T.sp.md).pr(T.sp.xs).gap(T.sp.xs).items_center().rounded(T.r.ctrl)
        .bg(`${t.accent}1f`).cursor_pointer().tooltip("Show all steps").on_click((_e, cx) => { ws.paRun = null; cx.notify(); })
        .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.accent).child(`Run: ${run.title}`)).child(iconEl("x", t.accent, 11))))
      .child(chips(ws, t, mine, f, "mp-pa")))
    .child(card(t, "mp-pa").overflow_hidden()
      .when(rows.length === 0, (el) => el.child(emptyLine(t, "mp-pa-empty", all.length ? "Nothing matches this filter." : err ? `No activity yet (${err}).` : "No activity yet.",
        all.length ? ["Show all", () => { ws.paFilter = "all"; ws.paAgent = null; }] : null)))
      .when(rows.length > 0, (el) => el.child(v_flex().relative().w_full().h(H).px(T.sp.md)
        .child(listEl)
        // Pinned day header: covers the list's first row with the day you are in.
        .when(Boolean(topDay) && S.top > 0, (e) => e.child(div().absolute().top(0).left(T.sp.md).right(T.sp.md)
          .child(dayHead(t, "mp-pa-pin", dayLabel(topDay), perDay.get(topDay) ?? 0))))
        .child(div().absolute().top(2).bottom(2).right(0).w(6).child(Scrollbar.vertical("mp-pa-list").mode("scrolling").size_full())))))
    .child(h_flex().gap(T.sp.lg).items_center().text_size(T.text.xs).text_color(t.dim)
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "J")).child(kbd(t, "K")).child("move"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "↵")).child("open task"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "1-6")).child("filter")));
}

// Toolbar of the full view: title, count, Runs | Steps, the agent picker (and the step filters, added by the caller).
function toolbar(ws, t, p, mode, count, all, agent) {
  const seg = h_flex().flex_none().p(T.sp.xxs).gap(T.sp.xxs).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
    .children([["runs", "Runs"], ["steps", "Steps"]].map(([k, l]) => h_flex().id(`mp-pa-m-${k}`).h(22).px(T.sp.md).rounded(T.r.chip).items_center().cursor_pointer()
      .text_size(T.text.sm).font_medium().bg(mode === k ? t.surface : clear).text_color(mode === k ? t.foreground : t.muted)
      .on_click((_e, cx) => { ws.paMode = k; if (k === "runs") ws.paRun = null; cx.notify(); }).child(l)));
  return h_flex().gap(T.sp.md).items_center()
    .child(div().text_size(T.text.lg).font_semibold().child("Activity"))
    .child(div().text_size(T.text.sm).text_color(t.dim).child(count))
    .child(div().flex_1())
    .child(seg)
    .child(agentPicker(ws, t, p, all, agent, "mp-pa"));
}

// Runs grouped by the day they ended (newest first), "Show more" pages of 40.
function runsView(ws, t, p, agent) {
  const all = projectRuns(ws, p, null);
  const runs = agent ? all.filter((r) => r.a === agent) : all;
  const shown = runs.slice(0, ws.paRunsN ?? RUNS_PAGE);
  const groups = [];
  for (const r of shown) { const d = dayOf(r.last); if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, runs: [] }); groups[groups.length - 1].runs.push(r); }
  const err = activityError();
  const steps = runs.reduce((n, r) => n + r.steps.length, 0);
  return v_flex().gap(T.sp.md)
    .child(toolbar(ws, t, p, "runs", `${runs.length} run${runs.length === 1 ? "" : "s"} · ${steps} steps`, all, agent))
    .when(runs.length === 0, (el) => el.child(card(t, "mp-pa-runs-empty").child(emptyLine(t, "mp-pa-empty", agent ? `No runs of ${who(agent)} yet.` : err ? `No activity yet (${err}).` : "No activity yet.",
      agent ? ["Show all agents", () => { ws.paAgent = null; }] : null))))
    .children(groups.map((g) => v_flex().gap(T.sp.xs)
      .child(h_flex().h(T.h.rowDense).px(T.sp.xs).gap(T.sp.md).items_center()
        .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(dayLabel(g.day)))
        .child(div().text_size(T.text.xs).text_color(t.dim).child(`${g.runs.length} run${g.runs.length === 1 ? "" : "s"}`)))
      .child(card(t, `mp-pa-day-${g.day}`).p(T.sp.xs).children(runList(ws, t, p, g.runs, { showAgent: !agent, idp: "mp-pa-run" })))))
    .when(runs.length > shown.length, (el) => el.child(h_flex().id("mp-pa-runs-more").h(T.h.btnSm).items_center().justify_center().rounded(T.r.ctrl).cursor_pointer()
      .border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { ws.paRunsN = (ws.paRunsN ?? RUNS_PAGE) + RUNS_PAGE; cx.notify(); })
      .child(div().text_size(T.text.xs).text_color(t.accent).child(`Show ${Math.min(RUNS_PAGE, runs.length - shown.length)} more of ${runs.length - shown.length}`))))
    .child(h_flex().gap(T.sp.lg).items_center().text_size(T.text.xs).text_color(t.dim)
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "J")).child(kbd(t, "K")).child("move"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "↵")).child("expand")));
}

// Polled by the Workspace (250 ms) while the view is open: re-render when the list scrolled into another day.
export const pinnedStale = () => S.shown !== S.topDay;
