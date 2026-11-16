// Project "Agents" tab: a dense, sortable table of every agent (Linear / GitHub list density) with row
// selection and a slim bulk bar (Start, Stop, Restart, Set risk, Auto-restart). Overview shows only a
// compact summary that links here. State lives on the Workspace (ws.ag*): sort, selection per project.
// Keyboard (workspace.js navMark): j/k move, Space / x select, Enter opens the agent, → its actions,
// 1-8 sort by that column (again: reverse), a selects all / none.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { run } from "herdr";
import { cardHead, relShort, exactTime, kbd, emptyLine } from "./ide.js";
import {
  liveAgent, currentTask, nextTask, startAgent, agentAvatar, iconEl, button, card, clear, demo, hp, toast, openTab, fmtTok,
  STATUS_EN, statusColor, OK, WARN, BAD, popFocus, restoreFocus, leadOf,
} from "./lib.js";
import { openForm, RISKS, riskOf } from "./form.js";
import { actItems, actCurrent, actTokens, actSession } from "./activity.js";
import { KIND } from "./activityview.js";
import { markManualStop, resetRestarts } from "./supervisor.js";
import { openAgentPage } from "./toolbar.js";

const sum4 = (v) => (v ? v[0] + v[1] + v[2] + v[3] : 0);
const STATUS_RANK = { blocked: 0, working: 1, idle: 2, done: 3 };

// One row of data per agent (everything the table shows and sorts by).
export function agentFacts(ws, p, a) {
  const live = liveAgent(p, a.name);
  const cur = currentTask(p, a.name);
  const now = live ? actCurrent(p.slug, a.name) : null;
  const items = actItems(p.slug, a.name);
  const lastEv = [...(ws.events ?? [])].reverse().find((e) => e.from === a.name);
  const lastT = Math.max(items[0]?.t ?? 0, lastEv ? new Date(lastEv.ts).getTime() || 0 : 0);
  const tk = actTokens(p.slug, a.name);
  // Model: the newest session's, else the agent's most used one.
  const sess = items.find((x) => x.s && x.s !== "hp");
  const model = (sess && actSession(p.slug, sess.s)?.model) || Object.entries(tk.models).sort((x, y) => sum4(y[1]) - sum4(x[1]))[0]?.[0] || "";
  const machines = (a.machines ?? []).length ? a.machines.filter((m) => p.machines.includes(m)) : p.machines;
  return {
    a, live, cur, now: now && !now.done ? now : null, lastT, model, risk: riskOf(a),
    engine: a.app === "codex" ? "Codex" : "Claude Code",
    status: live ? STATUS_EN[live.status] ?? live.status : "Stopped",
    statusRank: live ? STATUS_RANK[live.status] ?? 4 : 5,
    tok7: sum4(tk.d7), machines, allMachines: !(a.machines ?? []).length,
    task: cur ? `#${cur.id} ${cur.title}` : nextTask(p, a.name) ? `Next: #${nextTask(p, a.name).id} ${nextTask(p, a.name).title}` : "",
  };
}

// [key, label, width ("grow" = flexible), right-aligned, sort value, minimum view width to show]
const COLS = [
  ["name", "Name", 180, false, (f) => f.a.name.toLowerCase(), 0],
  ["status", "Status", 104, false, (f) => f.statusRank, 0],
  ["engine", "Engine / model", 150, false, (f) => `${f.engine} ${f.model}`.toLowerCase(), 1020],
  ["risk", "Risk", 84, false, (f) => RISKS.findIndex((r) => r[0] === f.risk), 760],
  ["task", "Current task", "grow", false, (f) => (f.cur ? `0${f.task}` : f.task ? `1${f.task}` : "2").toLowerCase(), 0],
  ["active", "Last active", 76, true, (f) => -(f.live?.status === "working" ? Date.now() : f.lastT), 880],
  ["tok7", "Tokens 7d", 72, true, (f) => -f.tok7, 680],
  ["machines", "Machines", 64, true, (f) => -f.machines.length, 1120],
];
const visibleCols = (W) => COLS.filter((c) => W >= c[5]);

export function sortAgents(ws, p, facts) {
  const s = ws.agSort ?? { key: "status", dir: 1 };
  const col = COLS.find((c) => c[0] === s.key) ?? COLS[1];
  const v = col[4];
  return [...facts].sort((x, y) => {
    const a = v(x), b = v(y);
    const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return (c || x.a.name.localeCompare(y.a.name)) * s.dir;
  });
}
function setSort(ws, key) {
  const s = ws.agSort ?? { key: "status", dir: 1 };
  ws.agSort = s.key === key ? { key, dir: -s.dir } : { key, dir: 1 };
}

// Selection (names) of this project's table.
function selOf(ws, p) {
  if (ws.agSelFor !== p.slug) { ws.agSelFor = p.slug; ws.agSel = new Set(); }
  for (const n of [...ws.agSel]) if (!p.agents.some((a) => a.name === n)) ws.agSel.delete(n);
  return ws.agSel;
}

function checkbox(t, id, on, mixed, onToggle) {
  return h_flex().id(id).flex_none().size(14).rounded(T.r.chip).items_center().justify_center().cursor_pointer()
    .border_1().border_color(on || mixed ? t.accent : t.input).bg(on || mixed ? t.accent : clear)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onToggle(cx); cx.notify(); })
    .when(on, (el) => el.child(iconEl("check", t.accent_foreground, 10)))
    .when(!on && mixed, (el) => el.child(div().w(8).h(2).rounded_full().bg(t.accent_foreground)));
}

// ------------------------------------------------------------ bulk actions
async function bulk(ws, cx, p, names, what, val) {
  const list = p.agents.filter((a) => names.includes(a.name));
  if (!list.length) return;
  const label = { start: "Started", stop: "Stopped", restart: "Restarted", risk: "Risk set", auto: "Auto-restart" }[what];
  if (demo()) { toast(`${label}: ${list.length} agent${list.length === 1 ? "" : "s"}`, "Demo mode: nothing was changed.", "success"); return; }
  let bad = 0;
  for (const a of list) {
    const live = liveAgent(p, a.name);
    if (what === "start" && !live) { resetRestarts(p.slug, a.name); startAgent(p, a); }
    else if (what === "stop" && live) { markManualStop(p.slug, a.name); run("terminal.kill", { terminal: live.address }); }
    else if (what === "restart") {
      if (live) { markManualStop(p.slug, a.name); run("terminal.kill", { terminal: live.address }); }
      cx.timer.after(live ? 1500 : 0, () => { resetRestarts(p.slug, a.name); startAgent(p, a); });
    } else if (what === "risk" || what === "auto") {
      const r = await hp(["agent", "set", a.name], { p: p.slug, ...(what === "risk" ? { risk: val } : { autorestart: val ? "on" : "off" }) });
      if (!r.ok) bad++;
      else if (what === "risk") a.risk = val; else a.autorestart = val;
    }
  }
  if (bad) toast(`${bad} of ${list.length} not changed`, "hp agent set failed; see hp agent list.", "error");
  else toast(`${label}${what === "risk" ? `: ${RISKS.find((r) => r[0] === val)?.[1]}` : what === "auto" ? (val ? " on" : " off") : ""}`, `${list.length} agent${list.length === 1 ? "" : "s"}`, "success");
  ws.reload(cx);
}

function bulkBar(ws, t, p, sel) {
  const names = [...sel];
  const n = names.length;
  const go = (what, val) => (_e, cx) => { ws.agMenu = null; restoreFocus("ag-menu"); cx.spawn(async (cx) => bulk(ws, cx, p, names, what, val)); cx.notify(); };
  const menu = (k, label, items) => Popover.new(`mp-agb-dd-${k}`).anchor("top_left").open(ws.agMenu === k)
    .on_open_change((o, cx) => { ws.agMenu = o ? k : null; popFocus(o, "ag-menu"); cx.notify(); })
    .trigger(h_flex().id(`mp-agb-${k}`).flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
      .text_size(T.text.sm).font_medium().text_color(t.foreground).hover((s) => s.bg(t.hover))
      .child(label).child(iconEl("chevron-right", t.dim, 11)))
    .content(v_flex().w(220).py(T.sp.xs).mt(T.sp.xs).rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_md()
      .children(items.map((it) => h_flex().id(`mp-agb-${k}-${it.key}`).h(T.h.rowDense).mx(T.sp.xs).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
        .text_size(T.text.sm).hover((s) => s.bg(t.hover)).on_click(it.go)
        .child(it.lead ?? div().w(0)).child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.sub), (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(it.sub))))));
  const act = (k, label, icon, fn) => h_flex().id(`mp-agb-${k}`).flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
    .text_size(T.text.sm).font_medium().text_color(t.foreground).hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(fn)
    .child(iconEl(icon, t.muted, 12)).child(label);
  const sep = () => div().flex_none().w(1).h(14).bg(t.border);
  return h_flex().id("mp-agb").h(T.h.row).px(T.sp.md).gap(T.sp.xs).items_center().rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
    .child(div().flex_none().pr(T.sp.md).text_size(T.text.sm).font_medium().child(`${n} selected`))
    .child(sep())
    .child(act("start", "Start", "play", go("start")))
    .child(act("stop", "Stop", "square", go("stop")))
    .child(act("restart", "Restart", "loop", go("restart")))
    .child(sep())
    .child(menu("risk", "Set risk", RISKS.map(([val, short, full, color]) => ({ key: val, label: short, sub: "", lead: div().size(T.dot).rounded_full().bg(color), go: go("risk", val) }))))
    .child(menu("auto", "Auto-restart", [{ key: "on", label: "On", sub: "restart while work is open", go: go("auto", true) }, { key: "off", label: "Off", go: go("auto", false) }]))
    .child(div().flex_1())
    .child(h_flex().id("mp-agb-clear").flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
      .text_size(T.text.xs).text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { sel.clear(); cx.notify(); }).child("Clear").child(kbd(t, "Esc")));
}

// ------------------------------------------------------------ the tab
export function agentsTab(ws, t, p) {
  const sel = selOf(ws, p);
  const W = ws.width;
  const cols = visibleCols(W);
  const facts = sortAgents(ws, p, p.agents.map((a) => agentFacts(ws, p, a)));
  const s = ws.agSort ?? { key: "status", dir: 1 };
  const all = facts.length > 0 && facts.every((f) => sel.has(f.a.name));
  const some = facts.some((f) => sel.has(f.a.name));
  // List-level keys (workspace.js onKey falls back to these): 1-8 sort, a = select all / none, Esc clears.
  ws.navKeys = {
    a: () => { if (all) sel.clear(); else for (const f of facts) sel.add(f.a.name); },
    ...Object.fromEntries(cols.map((c, i) => [String(i + 1), () => setSort(ws, c[0])])),
  };
  if (sel.size) ws.navEsc = () => sel.clear();
  const toggle = (name) => { if (sel.has(name)) sel.delete(name); else sel.add(name); };
  const cellW = (el, c) => (c[2] === "grow" ? el.flex_1().min_w(80) : el.flex_none().w(c[2]));
  const head = h_flex().id("mp-agt-head").h(T.h.rowDense).pl(T.sp.lg).pr(T.sp.lg).gap(T.sp.lg).items_center().border_b_1().border_color(t.border)
    .child(checkbox(t, "mp-agt-all", all, some && !all, () => { if (all) sel.clear(); else for (const f of facts) sel.add(f.a.name); }))
    .children(cols.map((c, i) => cellW(h_flex().id(`mp-agt-h-${c[0]}`).gap(T.sp.xs).items_center().min_w(0).cursor_pointer()
      .when(c[3], (el) => el.justify_end())
      .tooltip(`Sort by ${c[1].toLowerCase()} (${i + 1})`)
      .on_click((_e, cx) => { setSort(ws, c[0]); cx.notify(); })
      .child(div().min_w(0).truncate().text_size(T.text.xs).font_medium().text_color(s.key === c[0] ? t.foreground : t.dim).hover((x) => x.text_color(t.foreground)).child(c[1]))
      .when(s.key === c[0], (el) => el.child(iconEl(s.dir > 0 ? "chevron-up" : "chevron-down", t.muted, 10))), c)));
  const rows = facts.map((f) => row(ws, t, p, f, cols, sel.has(f.a.name), () => toggle(f.a.name)));
  const live = facts.filter((f) => f.live).length;
  return v_flex().gap(T.sp.md)
    .child(h_flex().gap(T.sp.md).items_center()
      .child(div().text_size(T.text.lg).font_semibold().child("Agents"))
      .child(div().text_size(T.text.sm).text_color(t.dim).child(`${p.agents.length} · ${live} live`))
      .child(div().flex_1())
      .child(button(t, "mp-agt-add", "Add Agent", () => openForm("agent-new", { project: p.slug }), { small: true, ghost: true, iconName: "plus" })))
    .when(sel.size > 0, (el) => el.child(bulkBar(ws, t, p, sel)))
    .child(card(t, "mp-agt").overflow_hidden()
      .when(p.agents.length === 0, (el) => el.child(emptyLine(t, "mp-agt-empty", "No agents yet.", ["Add an agent", () => openForm("agent-new", { project: p.slug })])))
      .when(p.agents.length > 0, (el) => el.child(head).children(rows)))
    .child(h_flex().gap(T.sp.lg).items_center().text_size(T.text.xs).text_color(t.dim)
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "Space")).child("select"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "↵")).child("open"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "→")).child("actions"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "1-8")).child("sort"))
      .child(h_flex().gap(T.sp.xs).items_center().child(kbd(t, "A")).child("select all")));
}

function row(ws, t, p, f, cols, on, toggle) {
  const a = f.a;
  const open = () => openAgentPage(p.slug, a.name, "projects");
  const r = RISKS.find((x) => x[0] === f.risk);
  const cellOf = (c) => {
    switch (c[0]) {
      case "name": return h_flex().gap(T.sp.md).items_center().min_w(0)
        .child(agentAvatar(t, a.name, f.live, 18))
        .child(div().flex_shrink_1().min_w(0).truncate().text_size(T.text.sm).font_medium().child(a.name))
        .when(a.name === leadOf(p), (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("lead")));
      case "status": return h_flex().gap(T.sp.sm).items_center().min_w(0)
        .child(div().flex_none().size(T.dot).rounded_full().bg(f.live ? statusColor(t, f.live.status) : t.dim))
        .child(div().min_w(0).truncate().text_size(T.text.sm).text_color(f.live ? t.foreground : t.muted).child(f.status));
      case "engine": return div().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted).child(f.model ? `${f.engine} · ${f.model}` : f.engine);
      case "risk": return div().min_w(0).truncate().text_size(T.text.sm).text_color(f.risk === "balanced" ? t.muted : r[3]).child(r[1]);
      case "task": {
        const k = f.now ? KIND[f.now.kind] ?? KIND.tool : null;
        return h_flex().gap(T.sp.sm).items_center().min_w(0)
          .when(Boolean(k), (el) => el.child(iconEl(k[0], k[1], 12)))
          .when(f.cur?.status === "blocked", (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(BAD)))
          .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(f.cur ? t.foreground : t.dim)
            .child(f.now ? `${f.now.text}${f.cur ? ` · #${f.cur.id}` : ""}` : f.task || "No task"));
      }
      case "active": return div().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted)
        .child(f.live?.status === "working" ? "now" : f.lastT ? relShort(f.lastT) : "—");
      case "tok7": return div().min_w(0).truncate().text_size(T.text.sm).text_color(f.tok7 ? t.foreground : t.dim).child(f.tok7 ? fmtTok(f.tok7) : "–");
      case "machines": return div().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted).child(f.allMachines ? `all ${f.machines.length}` : String(f.machines.length));
    }
    return div();
  };
  const tip = (c) => c[0] === "task" ? (f.now ? f.now.text : f.task) : c[0] === "active" ? (f.lastT ? exactTime(f.lastT) : "No activity recorded")
    : c[0] === "machines" ? (f.machines.length ? f.machines.join(", ") : "No machines") : c[0] === "risk" ? r[2] : c[0] === "engine" ? `${f.engine}${f.model ? " · " + f.model : ""}` : null;
  const el = h_flex().id(`mp-agt-r-${a.name}`).h(T.h.row).pl(T.sp.lg).pr(T.sp.lg).gap(T.sp.lg).items_center().border_b_1().border_color(t.border).cursor_pointer()
    .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { open(); cx.notify(); })
    .child(checkbox(t, `mp-agt-c-${a.name}`, on, false, toggle))
    .children(cols.map((c) => {
      let x = cellOf(c);
      x = c[2] === "grow" ? x.flex_1().min_w(80) : x.flex_none().w(c[2]);
      if (c[3]) x = x.text_right().justify_end();
      const tp = tip(c);
      return tp ? h_flex().id(`mp-agt-${c[0]}-${a.name}`).min_w(0).when(c[2] === "grow", (e) => e.flex_1()).when(c[2] !== "grow", (e) => e.flex_none()).when(c[3], (e) => e.justify_end()).tooltip(tp).child(x) : x;
    }));
  return ws.navMark(el, {
    key: `a:${a.name}`, open, ref: { kind: "agent", slug: p.slug, name: a.name },
    keys: { space: toggle, x: toggle },
  });
}

// ------------------------------------------------------------ overview summary
// Compact: counts by status, tokens this week, one line per agent that needs you; "Open table" → the tab.
export function agentsSummary(ws, t, p) {
  const facts = p.agents.map((a) => agentFacts(ws, p, a));
  const by = (k) => facts.filter((f) => (k === "stopped" ? !f.live : f.live?.status === k)).length;
  const stats = [["working", "working", OK], ["blocked", "waiting", WARN], ["idle", "idle", "#9aa3ad"], ["stopped", "stopped", t.dim]].map(([k, label, c]) => [by(k), label, c]).filter(([n]) => n);
  const tok = facts.reduce((s, f) => s + f.tok7, 0);
  const waiting = facts.filter((f) => f.live?.status === "blocked" || f.cur?.status === "blocked").slice(0, 3);
  const open = (_e, cx) => { openTab("agents"); cx?.notify?.(); };
  return card(t, "mp-agents").overflow_hidden()
    .child(cardHead(t, `Agents (${p.agents.length})`, h_flex().id("mp-ag-open").flex_none().gap(T.sp.xs).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(open).child(div().text_size(T.text.xs).font_medium().text_color(t.accent).hover((s) => s.opacity(0.8)).child("Open table")).child(iconEl("chevron-right", t.accent, 11))))
    .when(p.agents.length === 0, (el) => el.child(emptyLine(t, "mp-ag-empty", "No agents yet.", ["Add an agent", () => openForm("agent-new", { project: p.slug })])))
    .when(p.agents.length > 0, (el) => el
      .child(h_flex().px(T.pad.card).pb(T.sp.md).gap(T.sp.lg).items_center().flex_wrap()
        .children(stats.map(([n, label, c]) => h_flex().gap(T.sp.sm).items_center()
          .child(div().size(T.dot).rounded_full().bg(c)).child(div().text_size(T.text.sm).child(String(n))).child(div().text_size(T.text.xs).text_color(t.muted).child(label))))
        .child(div().flex_1())
        .when(tok > 0, (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(`${fmtTok(tok)} tokens · 7d`))))
      // Avatars (click → the agent), then the ones that need you.
      .child(h_flex().px(T.pad.card).pb(waiting.length ? T.sp.sm : T.pad.card).gap(T.sp.xs).flex_wrap()
        .children(sortAgents({ agSort: { key: "status", dir: 1 } }, p, facts).map((f) => ws.navMark(h_flex().id(`mp-ag-chip-${f.a.name}`).h(T.h.btnSm).pl(T.sp.xs).pr(T.sp.md).gap(T.sp.sm).items_center()
          .rounded(T.r.ctrl).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(`${f.status}${f.task ? " · " + f.task : ""}`)
          .on_click((_e, cx) => { openAgentPage(p.slug, f.a.name, "projects"); cx.notify(); })
          .child(agentAvatar(t, f.a.name, f.live, 16)).child(div().text_size(T.text.sm).child(f.a.name))
          .when(f.a.name === leadOf(p), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child("lead"))),
        { key: `a:${f.a.name}`, open: () => openAgentPage(p.slug, f.a.name, "projects"), ref: { kind: "agent", slug: p.slug, name: f.a.name } }))))
      .children(waiting.map((f) => h_flex().id(`mp-ag-wait-${f.a.name}`).h(T.h.rowDense).mx(T.sp.md).px(T.sp.sm).gap(T.sp.md).items_center().rounded(T.r.ctrl)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { openAgentPage(p.slug, f.a.name, "projects"); cx.notify(); })
        .child(div().flex_none().size(T.dot).rounded_full().bg(f.live?.status === "blocked" ? WARN : BAD))
        .child(div().flex_none().text_size(T.text.sm).font_medium().child(f.a.name))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted)
          .child(f.live?.status === "blocked" ? "is waiting for you" : `blocked: ${f.cur.title}${f.cur.blocked_reason ? " — " + f.cur.blocked_reason : ""}`))))
      .when(waiting.length > 0, (e) => e.child(div().h(T.sp.md))));
}
