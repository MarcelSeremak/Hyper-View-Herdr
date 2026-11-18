// Dashboard (full-width view, shared("mp.view") = { kind: "dashboard" }): a row of stat tiles (big number +
// sparkline), then "Needs you" (left: one list grouped by state — Needs you → Working → Ready → Done today)
// beside the charts (activity by project, tokens per day, task throughput), then a short cross-project
// board and the machines heat grid + limits. Stacks below 1100 px.
// Keys (the center view's focus, workspace.js → dashKey): j/k or ↓/↑ move, Enter opens, → actions, a approves, Esc clears.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { shared, setShared, run } from "herdr";
import {
  demo, listProjects, loadProject, loadEvents, loadMachines, liveAgent, currentTask, selectProject, showCenter, hp, toast, startAgent,
  vmStats, agentAvatar, clear, arr, tile, colorFor, OK, WARN, BAD, INFO, TASK_COLOR, PRIO, scrollY,
} from "./lib.js";
import { sparkLine, columnChart, legend, heatGrid, loadColor, fmtNum } from "./charts.js";
import { loadMailbox, publishCount } from "./mailbox.js";
import { openTaskPanel, epicKids } from "./taskpanel.js";
import { actCurrent, actDays } from "./activity.js";
import { T } from "./tokens.js";
import { relTime, hoverAction, skeleton, emptyLine } from "./ide.js";

const DAY = 86400000;
const CLAUDE = "#c98a6c", CODEX = "#6aa58f";
const GROUPS = [
  ["needs", "Needs you", WARN, "need you"],
  ["working", "Working", OK, "working"],
  ["ready", "Ready", INFO, "ready"],
  ["done", "Done today", OK, "done today"],
];
const S = {
  at: 0, loading: false, projects: [], machines: [], mail: [], gone: new Set(),
  filter: null, doneOpen: false, whoW: 232, sel: -1, fh: null, replyId: null, input: null, flat: [], hover: null,
};

// ------------------------------------------------------------ data
async function load() {
  const out = [];
  for (const p0 of await listProjects()) {
    const full = await loadProject(p0.slug).catch(() => null);
    // Only the timestamps of the last 30 days are kept (the sparkline): whole event logs of every
    // project, reloaded every few seconds, were the dashboard's biggest allocation.
    const since = Date.now() - 31 * DAY;
    const events = arr(await loadEvents(p0.slug).catch(() => [])).filter((e) => ms(e.ts) >= since).map((e) => ({ ts: e.ts }));
    out.push({ ...(full ?? {}), ...p0, agents: arr(p0.agents), machines: arr(p0.machines), tasks: arr(full?.tasks), events });
  }
  return out;
}
function refresh(cx) {
  S.loading = Date.now();
  cx.spawn(async (cx) => {
    try {
      S.projects = await load();
      S.machines = await loadMachines();
      const mb = await loadMailbox(); // same items as the Mailbox: questions, approvals, blocked and review tasks
      S.mail = mb.items.filter((it) => !it.auto && !mb.done.has(it.id));
      publishCount(S.mail.length);
    } catch {}
    S.at = Date.now(); S.loading = 0;
    cx.notify();
  });
}

const ms = (ts) => (ts ? new Date(ts).getTime() : 0);
function rel(ts) {
  const s = (Date.now() - ms(ts)) / 1000;
  if (!ts || !Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return m && h < 10 ? `${h}h ${m}m` : `${h}h`; }
  return `${Math.floor(s / 86400)}d`;
}
const who = (p) => (p.loose ? "loose" : p.name);
const jump = (live) => () => { run("agent.focus", { terminal: live.address }); showCenter("mp-terms"); };
const openTask = (slug, id) => () => { selectProject(slug, "tasks"); openTaskPanel(slug, id); showCenter("mp-view"); };
function openAgent(p, name) {
  return () => {
    if (p.loose) selectProject(p.slug, "overview");
    else { selectProject(p.slug, "agents"); setShared("mp.openAgent", { slug: p.slug, name, at: Date.now() }); }
    showCenter("mp-view");
  };
}

// Answers go through hp like the Mailbox does (approve for approval requests, say otherwise).
function send(cx, it, text) {
  S.gone.add(it.id); S.replyId = null; cx.notify();
  if (demo()) { toast("Demo mode", "Nothing was sent.", "info"); return; }
  cx.spawn(async (cx) => {
    const p = it.proj;
    const to = p.loose ? p.agents[0]?.name ?? it.from : it.from;
    const r = await hp(["say", text], { p: it.slug, as: "ty", to, task: it.task ? String(it.task) : undefined });
    if (r.ok && p.loose && p.agents[0] && !liveAgent(p, p.agents[0].name)) startAgent(p, p.agents[0], text);
    if (!r.ok) { S.gone.delete(it.id); toast("Message not sent", r.err, "error"); cx.notify(); }
  });
}
function approve(cx, it) {
  if (it.kind === "ask") return send(cx, it, "Approved. Go ahead.");
  S.gone.add(it.id); cx.notify();
  if (demo()) { toast("Demo mode", "Nothing was approved.", "info"); return; }
  cx.spawn(async (cx) => {
    const r = await hp(["approve", String(it.approvalId)], { p: it.slug, as: "ty" });
    if (!r.ok) { S.gone.delete(it.id); toast("Not approved", r.err, "error"); cx.notify(); }
  });
}
function replyInput() {
  if (!S.input) {
    S.input = InputState.new({ placeholder: "Answer…" });
    S.input.on("submit", (_e, cx) => {
      const it = S.mail.find((x) => x.id === S.replyId);
      const text = S.input.value().trim();
      if (it && text) { S.input.set_value(""); send(cx, it, text); }
    });
  }
  return S.input;
}
function startReply(cx, it) {
  S.replyId = S.replyId === it.id ? null : it.id;
  if (S.replyId) { const inp = replyInput(); inp.set_value(""); inp.focus(); }
  cx.notify();
}

// Row: { key, dot, name, p, live, ts, text, act: [label, fn(cx)], act2?, approve?, open?, item?, prio? }
function rows() {
  const P = S.projects;
  const bySlug = new Map(P.map((p) => [p.slug, p]));
  const needs = [], working = [], ready = [], done = [];
  const RANK = { approval: 0, ask: 1, wait: 2, blocked: 3, review: 4, msg: 5 };
  const asked = new Set();
  for (const it of S.mail) {
    if (S.gone.has(it.id)) continue;
    const p = bySlug.get(it.slug) ?? it.proj;
    const live = liveAgent(p, it.from);
    if (it.kind === "task") {
      needs.push({ key: it.id, rank: RANK[it.status] ?? 5, dot: it.status === "blocked" ? BAD : INFO, name: it.from, p, live, ts: it.ts,
        text: `${it.status === "blocked" ? "Blocked" : "Review"} · ${it.text}`, act: ["Open", openTask(it.slug, it.taskId)], taskId: it.taskId });
      continue;
    }
    asked.add(`${it.slug}\t${it.from}`);
    const canApprove = it.kind === "ask" || (it.kind === "approval" && Boolean(it.approvalId));
    needs.push({ key: it.id, rank: RANK[it.kind] ?? 5, dot: WARN, name: it.from, p, live, ts: it.ts, text: it.text, item: it,
      act: canApprove ? ["Approve", (cx) => approve(cx, it)] : ["Answer", (cx) => startReply(cx, it)],
      act2: canApprove ? ["Answer", (cx) => startReply(cx, it)] : null,
      approve: canApprove ? (cx) => approve(cx, it) : null,
      open: (cx) => startReply(cx, it) });
  }
  for (const p of P) {
    for (const a of p.agents) {
      const live = liveAgent(p, a.name);
      if (!live) continue;
      const task = p.loose ? null : currentTask(p, a.name);
      if (live.status === "blocked") {
        if (asked.has(`${p.slug}\t${a.name}`)) continue; // its question is already a row
        needs.push({ key: `w:${p.slug}:${a.name}`, rank: RANK.wait, dot: WARN, name: a.name, p, live, ts: null,
          text: task ? `Waiting in the terminal · #${task.id} ${task.title}` : "Waiting in the terminal", act: ["Jump", jump(live)] });
      } else if (live.status === "working") {
        const now = actCurrent(p.slug, a.name);
        const doing = now && !now.done ? now.text : null;
        const parts = [doing, task ? `#${task.id} ${task.title}` : null].filter(Boolean);
        working.push({ key: `a:${p.slug}:${a.name}`, dot: OK, name: a.name, p, live, ts: task?.started ?? (now?.t ? new Date(now.t).toISOString() : null),
          text: parts.join(" · ") || a.role || "Working", act: ["Terminal", jump(live)], open: openAgent(p, a.name) });
      }
    }
    for (const x of p.tasks) {
      if (x.status === "todo") {
        const live = x.agent ? liveAgent(p, x.agent) : null;
        ready.push({ key: `t:${p.slug}:${x.id}`, dot: INFO, name: x.agent || "unassigned", p, live, ts: x.created, prio: x.priority,
          text: `#${x.id} ${x.title}${live ? " · queued" : ""}`, act: ["Open", openTask(p.slug, x.id)] });
      } else if (x.status === "done" && x.completed && Date.now() - ms(x.completed) < DAY) {
        done.push({ key: `d:${p.slug}:${x.id}`, dot: TASK_COLOR.done, name: x.agent || "–", p, live: null, ts: x.completed,
          text: `#${x.id} ${x.title}`, act: ["Open", openTask(p.slug, x.id)] });
      }
    }
  }
  const newest = (a, b) => ms(b.ts) - ms(a.ts);
  const PR = { urgent: 0, high: 1, normal: 2, low: 3 };
  needs.sort((a, b) => a.rank - b.rank || newest(a, b));
  working.sort((a, b) => ms(a.ts) - ms(b.ts));
  ready.sort((a, b) => (PR[a.prio] ?? 2) - (PR[b.prio] ?? 2) || ms(a.ts) - ms(b.ts));
  done.sort(newest);
  return { needs, working, ready, done };
}

// ------------------------------------------------------------ list
// Calm, Linear-Inbox-like: filter tabs, then groups (11px dim header + count) of 36px rows with no
// boxes around them. A row: status dot, 18px avatar, agent · project, text, time; its one action
// (Approve / Answer / Open …) appears on hover or keyboard selection, as a ghost button.
const txt = (size, color) => div().text_size(size).text_color(color);
function ghost(t, id, [label, fn]) {
  return h_flex().id(id).flex_none().h(24).px(T.sp.md).rounded(T.r.ctrl).items_center().cursor_pointer()
    .text_size(T.text.xs).font_medium().text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); }).child(label);
}
function row(t, r, i) {
  const k = `mp-dk-r-${r.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const sel = S.sel === i, hot = S.hover === r.key || sel;
  const el = h_flex().id(k).h(T.h.row).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
    .bg(sel ? t.hover : clear).hover((s) => s.bg(t.hover))
    .on_hover((h, cx) => { const nk = h ? r.key : S.hover === r.key ? null : S.hover; if (nk !== S.hover) { S.hover = nk; cx.notify(); } })
    .on_click((_e, cx) => { S.sel = i; (r.open ?? r.act[1])(cx); cx.notify(); })
    .child(div().flex_none().size(T.dot).rounded_full().bg(r.dot))
    .child(agentAvatar(t, r.name, r.live, 18))
    // Fixed-width "agent · project" column, so every row's text starts at the same x.
    .child(h_flex().flex_none().w(S.whoW).min_w(0).gap(T.sp.xs).items_center().overflow_hidden()
      .child(div().flex_none().max_w(Math.round(S.whoW * 0.62)).truncate().text_size(T.text.sm).font_medium().child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.dim).child(`· ${who(r.p)}`)))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted).child(r.text))
    .when(r.prio === "urgent" || r.prio === "high", (e) => e.child(txt(T.text.xs, r.prio === "urgent" ? BAD : WARN).flex_none().child(r.prio)))
    .child(relTime(t, `${k}-ts`, r.ts, { text: rel(r.ts) }))
    // Fixed slot so the text does not jump when the action appears; the action shows its key
    // (A approves, ↵ opens) — Raycast's action panel / Linear's hover hints.
    .child(h_flex().flex_none().w(104).justify_end().when(hot, (e) => e.child(hoverAction(t, `${k}-a`, r.act[0], (cx) => r.act[1](cx), r.approve ? "A" : "Enter"))));
  if (!(r.item && S.replyId === r.item.id)) return el;
  return v_flex().child(el).child(h_flex().pl(38).pr(T.sp.md).pb(T.sp.sm).gap(T.sp.sm).items_center()
    .child(h_flex().id(`${k}-in`).flex_1().h(T.h.input).px(T.sp.md).items_center().rounded(T.r.ctrl).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(replyInput()).flex_1().h(26).text_size(T.text.sm).text_color(t.foreground)))
    .when(Boolean(r.approve), (e) => e.child(ghost(t, `${k}-ok`, ["Approve", r.approve])))
    .child(hoverAction(t, `${k}-x`, "Cancel", () => { S.replyId = null; }, "Esc")));
}
// Text segmented filter: Needs you · Working · Ready · Done today, counts as dim numbers. Nothing
// picked = every group; clicking the picked one again clears the filter.
function tabs(t, G) {
  const all = GROUPS.map(([g, label]) => [g, label, G[g].length]);
  return h_flex().id("mp-dk-tabs").flex_wrap().gap(T.sp.xxs).items_center()
    .children(all.map(([g, label, n]) => {
      const on = S.filter === g;
      return h_flex().id(`mp-dk-c-${g ?? "all"}`).h(T.h.btn).px(T.sp.md).gap(T.sp.sm).rounded(T.r.ctrl).items_center().cursor_pointer()
        .bg(on ? t.raised : clear).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { S.filter = on ? null : g; S.sel = -1; if (g === "done") S.doneOpen = true; cx.notify(); })
        .child(txt(T.text.sm, on ? t.foreground : t.muted).font_medium().child(label))
        .child(txt(T.text.xs, t.dim).child(String(n)));
    }));
}
function list(t, G) {
  const flat = [];
  const out = v_flex();
  let first = true;
  for (const [g, label] of GROUPS) {
    if (S.filter && S.filter !== g) continue;
    const items = G[g];
    if (!items.length && g !== "needs") continue;
    const folded = g === "done" && !S.doneOpen && S.filter !== "done";
    // Counts live in the filter tabs above; a filtered list (one group) needs no header at all.
    if (!S.filter) out.child(h_flex().id(`mp-dk-g-${g}`).h(T.h.rowDense).mt(first ? 0 : T.sp.lg).px(T.sp.md).gap(T.sp.sm).items_center()
      .when(g === "done", (e) => e.cursor_pointer().on_click((_e, cx) => { S.doneOpen = !S.doneOpen; cx.notify(); }))
      .child(txt(T.text.xs, t.muted).font_medium().child(label))
      .when(g === "done", (e) => e.child(txt(T.text.xs, t.dim).hover((s) => s.text_color(t.foreground)).child(folded ? "show" : "hide"))));
    first = false;
    if (g === "needs" && !items.length) { out.child(emptyLine(t, "mp-dk-empty", "Nothing needs you right now.", ["Open mailbox", () => import("./lib.js").then((l) => l.openMailbox()), "G M"])); continue; }
    if (folded) continue;
    // Unfiltered, each group shows its first rows (Needs you 8, others 5); "Show all" filters to the group.
    const cap = S.filter ? Infinity : g === "needs" ? 8 : 5;
    for (const r of items.slice(0, cap)) { out.child(row(t, r, flat.length)); flat.push(r); }
    if (items.length > cap) out.child(h_flex().id(`mp-dk-more-${g}`).h(T.h.rowDense).px(T.sp.md).pl(38).items_center().cursor_pointer()
      .on_click((_e, cx) => { S.filter = g; S.sel = -1; if (g === "done") S.doneOpen = true; cx.notify(); })
      .child(txt(T.text.xs, t.accent).hover((s) => s.opacity(0.8)).child(`Show all ${items.length}`)));
  }
  if (S.filter && !flat.length && S.filter !== "needs") out.child(emptyLine(t, "mp-dk-none", "Nothing here.", ["Show all", () => { S.filter = null; }, "Esc"]));
  S.flat = flat;
  if (S.sel >= flat.length) S.sel = flat.length - 1;
  return out;
}
// The entity a row is about (→ opens its actions in the palette).
function refOf(r) {
  if (!r?.p) return null;
  const m = /^[td]:(.+):([^:]+)$/.exec(r.key);
  if (m) return { kind: "task", slug: r.p.slug, id: m[2] };
  if (r.taskId != null) return { kind: "task", slug: r.p.slug, id: r.taskId };
  if (!r.name || r.name === "unassigned" || r.name === "–" || r.name === "ty") return null;
  return r.p.loose ? { kind: "loose", slug: r.p.slug, label: r.name } : { kind: "agent", slug: r.p.slug, name: r.name };
}
export function dashKey(e, cx) {
  const m = e.modifiers ?? {};
  if (m.control || m.alt || m.platform) return;
  const F = S.flat;
  const k = e.key;
  if (S.replyId) { if (k === "escape") { S.replyId = null; cx.notify(); cx.stop_propagation(); } return; }
  if (k === "j" || k === "down") S.sel = Math.min(F.length - 1, S.sel + 1);
  else if (k === "k" || k === "up") S.sel = Math.max(0, S.sel - 1);
  else if (k === "enter" && F[S.sel]) (F[S.sel].open ?? F[S.sel].act[1])(cx);
  else if (k === "a" && F[S.sel]?.approve) F[S.sel].approve(cx);
  else if ((k === "right" || k === "l" || k === ".") && refOf(F[S.sel])) import("./actions.js").then((a) => a.openActions(refOf(F[S.sel])));
  else if (k === "escape") { if (S.sel < 0 && S.filter) S.filter = null; S.sel = -1; }
  else return;
  cx.stop_propagation();
  cx.notify();
}

// ------------------------------------------------------------ insights: stat tiles, charts, board, machines
// Patterns: Grafana stat panels (big number + sparkline of the same metric), Vercel / Linear Insights
// (flat panels, 3 quiet y ticks, sparse x labels, hover tooltips per column), Datadog host map (one
// square per machine, colored by load). Charts are native paths + divs (charts.js): no files per tick.
const head = (t, title, meta, right) => h_flex().h(T.h.rowDense).gap(T.sp.sm).items_center()
  .child(txt(T.text.xs, t.muted).font_medium().flex_none().child(title))
  .when(Boolean(meta), (e) => e.child(txt(T.text.xs, t.dim).min_w(0).truncate().child(meta)))
  .child(div().flex_1())
  .when(Boolean(right), (e) => e.child(right));
const panel = (t, id) => v_flex().id(id).min_w(0).px(T.pad.cardRoomy).py(T.pad.card).gap(T.sp.md).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border);
const link = (t, id, label, fn) => h_flex().id(id).flex_none().gap(T.sp.xs).items_center().cursor_pointer()
  .on_click((_e, cx) => { fn(cx); cx.notify(); })
  .child(txt(T.text.xs, t.accent).hover((s) => s.opacity(0.8)).child(label));
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (d) => `${MONTH[d.getMonth()]} ${d.getDate()}`;
const N = 30;
const projColor = (p) => p.color ?? colorFor(`project:${p.name}`);
// Live samples (agents working, needs you) taken on every refresh, for the tiles' sparklines.
const HIST = (globalThis.__hvDashHist ??= { working: [], needs: [], at: 0 });
function sample(G) {
  if (Date.now() - HIST.at < 5000) return;
  HIST.at = Date.now();
  for (const [k, v] of [["working", G.working.length], ["needs", G.needs.length]]) { HIST[k].push(v); if (HIST[k].length > 48) HIST[k].shift(); }
}
// 30-day series, recomputed once per data refresh (not per frame).
let SER = { at: -1 };
function series() {
  if (SER.at === S.at && SER.demo === demo()) return SER;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: N }, (_, i) => new Date(today.getTime() - (N - 1 - i) * DAY));
  const idx = new Map(days.map((d, i) => [dayKey(d), i]));
  const at = (ts) => { const d = new Date(ts); return isNaN(d) ? -1 : idx.get(dayKey(d)) ?? -1; };
  const D = demo();
  const wave = (i, seed, base, amp) => { const d = days[i], wk = d.getDay() === 0 || d.getDay() === 6; return Math.max(0, Math.round((wk ? base * 0.35 : base) + amp * Math.sin((i + seed * 3) / 4.2) + amp * 0.6 * Math.sin(i * 1.7 + seed))); };
  // Activity by project (top 5 + other); loose agents count as one series.
  const real = S.projects.filter((p) => !p.loose);
  const per = real.map((p, pi) => {
    const v = new Array(N).fill(0);
    for (const e of p.events) { const i = at(e.ts); if (i >= 0) v[i]++; }
    if (D) for (let i = 0; i < N - 1; i++) v[i] += wave(i, pi + 1, [14, 9, 6, 5][pi % 4], [6, 4, 3, 2][pi % 4]);
    return { name: p.name, slug: p.slug, color: projColor(p), v };
  });
  const loose = new Array(N).fill(0);
  for (const p of S.projects.filter((x) => x.loose)) for (const e of p.events) { const i = at(e.ts); if (i >= 0) loose[i]++; }
  if (D) for (let i = 0; i < N - 1; i++) loose[i] += wave(i, 7, 3, 2);
  per.sort((a, b) => b.v.reduce((s, x) => s + x, 0) - a.v.reduce((s, x) => s + x, 0));
  const act = per.slice(0, 5);
  const other = per.slice(5).reduce((acc, x) => acc.map((n, i) => n + x.v[i]), new Array(N).fill(0));
  if (other.some(Boolean)) act.push({ name: "Other", color: "#6b6b80", v: other });
  if (loose.some(Boolean)) act.push({ name: "Loose agents", color: "#5f7f76", v: loose });
  // Tasks: done per day, created per day, open over time. (Demo projects share one task list: count it once.)
  const seen = new Set(), done = new Array(N).fill(0), created = new Array(N).fill(0);
  let openNow = 0;
  const tasks = [];
  for (const p of real) for (const x of p.tasks) {
    const k = D ? `${x.id}\t${x.title}` : `${p.slug}\t${x.id}`;
    if (seen.has(k)) continue; seen.add(k); tasks.push(x);
    if (x.status === "done") { const i = at(x.completed); if (i >= 0) done[i]++; } else openNow++;
    const c = at(x.created); if (c >= 0) created[c]++;
  }
  if (D) for (let i = 0; i < N - 1; i++) { done[i] += wave(i, 3, 4, 2); created[i] += wave(i, 5, 4, 2); }
  const open = new Array(N).fill(0);
  open[N - 1] = openNow;
  for (let i = N - 2; i >= 0; i--) open[i] = Math.max(0, open[i + 1] - created[i + 1] + done[i + 1]);
  // Tokens per day by provider.
  const tok = actDays(S.projects.map((p) => p.slug), N);
  const claude = tok.map((x) => x.claude ?? 0), codex = tok.map((x) => x.codex ?? 0);
  if (D && !claude.some(Boolean) && !codex.some(Boolean)) for (let i = 0; i < N; i++) { claude[i] = wave(i, 2, 9, 4) * 61000 + (i === N - 1 ? 180000 : 0); codex[i] = wave(i, 4, 5, 3) * 47000; }
  SER = { at: S.at, demo: D, days, labels: days.map(label), act, done, created, open, openNow, claude, codex, tasks };
  return SER;
}
const sum = (a, from = 0, to = a.length) => a.slice(from, to).reduce((s, x) => s + x, 0);

// Stat tile: label, big number, delta/sub line, sparkline of the same metric (Grafana stat panel).
function statTile(t, id, { label: lab, value, sub, color, values, spark: sc, onClick }) {
  return v_flex().id(id).flex_1().min_w(0).px(T.pad.cardRoomy).pt(T.pad.card).pb(T.sp.md).gap(T.sp.xs).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border)
    .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.border_color(t.input)).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
    .child(txt(T.text.xs, t.muted).font_medium().truncate().child(lab))
    .child(div().text_size(T.text.display).line_height(`${T.lh.display}px`).font_medium().text_color(color ?? t.foreground).truncate().child(String(value)))
    .child(txt(T.text.xs, t.dim).h(T.lh.xs).truncate().child(sub ?? ""))
    .child(div().pt(T.sp.xs).child(sparkLine(`${id}-sp`, values?.length ? values : [0, 0], sc ?? t.accent, "100%", 28, { stroke: 1.5 })));
}
function tiles(t, G, X, cw) {
  const agentsAll = S.projects.reduce((n, p) => n + p.agents.length, 0);
  const stats = vmStats(), M = S.machines;
  const up = M.filter((m) => stats[m.name]?.ok);
  const avgCpu = up.length ? Math.round(up.reduce((s, m) => s + (stats[m.name].cpu ?? 0), 0) / up.length) : null;
  const cpuHist = (() => { const hs = up.map((m) => stats[m.name].cpuHistory ?? []).filter((h) => h.length); const n = Math.min(30, ...hs.map((h) => h.length)); return hs.length ? Array.from({ length: n }, (_, i) => hs.reduce((s, h) => s + h[h.length - n + i], 0) / hs.length) : []; })();
  const d7 = sum(X.done, N - 7), p7 = sum(X.done, N - 14, N - 7);
  const delta = d7 - p7;
  const blocked = X.tasks.filter((x) => x.status === "blocked").length, review = X.tasks.filter((x) => x.status === "review").length;
  const tokToday = X.claude[N - 1] + X.codex[N - 1], tokY = X.claude[N - 2] + X.codex[N - 2];
  const pad = (h, v) => (h.length >= 2 && !demo() ? h : demo() ? Array.from({ length: 16 }, (_, i) => Math.max(0, v + Math.round(Math.sin(i / 2) * 1.2 - 0.4))) : [v, v]);
  const T6 = [
    { label: "Agents working", value: G.working.length, sub: `of ${agentsAll} agents`, values: pad(HIST.working, G.working.length), spark: OK, onClick: () => { S.filter = "working"; S.sel = -1; } },
    { label: "Needs you", value: G.needs.length, color: G.needs.length ? WARN : null, sub: G.needs.length ? "questions, approvals, reviews" : "all clear", values: pad(HIST.needs, G.needs.length), spark: WARN, onClick: () => { S.filter = "needs"; S.sel = -1; } },
    { label: "Tasks done · 7d", value: d7, sub: `${delta >= 0 ? "+" : ""}${delta} vs previous 7d`, values: X.done, spark: INFO },
    { label: "Open tasks", value: X.openNow, sub: `${blocked} blocked · ${review} in review`, values: X.open, spark: "#9aa3ad" },
    { label: "Machines online", value: M.length ? `${up.length}/${M.length}` : "0", color: up.length < M.length ? WARN : null, sub: avgCpu != null ? `avg CPU ${avgCpu}%` : "no machines", values: cpuHist, spark: t.accent, onClick: () => setShared("mp.view", { kind: "machines" }) },
    { label: "Tokens today", value: fmtNum(tokToday), sub: tokY ? `${tokToday >= tokY ? "+" : ""}${Math.round(((tokToday - tokY) / Math.max(1, tokY)) * 100)}% vs yesterday` : "Claude + Codex", values: X.claude.map((c, i) => c + X.codex[i]), spark: CLAUDE },
  ];
  const per = cw >= 1000 ? 6 : cw >= 640 ? 3 : 2;
  const rowsOut = [];
  for (let i = 0; i < T6.length; i += per) rowsOut.push(h_flex().id(`mp-dk-tr${i}`).w_full().gap(T.sp.lg).children(T6.slice(i, i + per).map((x, j) => statTile(t, `mp-dk-t${i + j}`, x))));
  return v_flex().w_full().gap(T.sp.lg).children(rowsOut);
}
function activityPanel(t, X, h) {
  const total = X.act.reduce((s, p) => s + sum(p.v), 0);
  const cols = X.labels.map((l, i) => {
    const segs = X.act.map((p) => [p.v[i], p.color]);
    const tot = segs.reduce((s, [v]) => s + v, 0);
    return { label: l, segs, tip: `${l} · ${tot} event${tot === 1 ? "" : "s"}${tot ? `\n${X.act.filter((p) => p.v[i]).map((p) => `${p.name} ${p.v[i]}`).join(" · ")}` : ""}` };
  });
  return panel(t, "mp-dk-act")
    .child(head(t, "Activity", `${fmtNum(total)} events · 30 days`, legend(t, X.act.map((p) => [p.name, p.color]))))
    .child(columnChart(t, "mp-dk-actc", cols, { h }));
}
function tokensPanel(t, X, h) {
  const total = sum(X.claude) + sum(X.codex);
  const cols = X.labels.map((l, i) => ({ label: l, segs: [[X.claude[i], CLAUDE], [X.codex[i], CODEX]], tip: `${l} · ${fmtNum(X.claude[i] + X.codex[i])} tokens\nClaude ${fmtNum(X.claude[i])} · Codex ${fmtNum(X.codex[i])}` }));
  return panel(t, "mp-dk-tok").flex_1()
    .child(head(t, "Tokens per day", `${fmtNum(total)} · 30 days`, legend(t, [["Claude", CLAUDE], ["Codex", CODEX]])))
    .child(columnChart(t, "mp-dk-tokc", cols, { h, xEvery: 7 }));
}
function throughputPanel(t, X, h) {
  const total = sum(X.done);
  const cols = X.labels.map((l, i) => ({ label: l, segs: [], tip: `${l} · ${X.done[i]} done · ${X.created[i]} created` }));
  return panel(t, "mp-dk-thr").flex_1()
    .child(head(t, "Tasks throughput", `${total} done · ${(total / N).toFixed(1)}/day`, legend(t, [["Done", OK], ["Created", "#9aa3ad"]])))
    .child(columnChart(t, "mp-dk-thrc", cols.map((c, i) => ({ ...c, segs: [[X.created[i], "#9aa3ad33"]] })), { h, xEvery: 7, max: Math.max(...X.done, ...X.created, 1), line: { values: X.done, color: OK, fill: true } }));
}
// Board: a short cross-project kanban (top 4 per column, "+N more" opens that project's Tasks).
// Done: only tasks finished in the last 24 h (newest first), so the column stays short.
const BOARD = [["todo", "To Do"], ["doing", "In Progress"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done · 24h"]];
const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
// Cards drawn per column (the rest: "+N more" opens the project's Tasks). With 40 per column the whole
// dashboard ran out of render time ("This view could not be re-rendered: interrupted").
const BOARD_MAX = 5;
function boardPanel(t, cw) {
  const seen = new Set(), by = Object.fromEntries(BOARD.map(([s]) => [s, []]));
  for (const p of S.projects) {
    if (p.loose) continue;
    for (const x of p.tasks) {
      if (!by[x.status]) continue;
      if (x.status === "done" && Date.now() - ms(x.completed ?? x.history?.[x.history.length - 1]?.ts) > DAY) continue;
      const k = demo() ? `${x.id}\t${x.title}` : `${p.slug}\t${x.id}`;
      if (seen.has(k)) continue; seen.add(k);
      by[x.status].push({ x, p });
    }
  }
  const card = ({ x, p }) => {
    const live = x.agent ? liveAgent(p, x.agent) : null;
    if (x.kind === "epic") {
      // An epic is a goal broken into tasks: green bar, EPIC, its tasks done / total (not a task card).
      const kids = epicKids(p, x), done = kids.filter((y) => y.status === "done").length;
      return h_flex().id(`mp-dk-b-${p.slug}-${x.id}`).w_full().min_w(0).rounded(T.r.ctrl).bg(t.background).border_1().border_color(`${OK}55`).overflow_hidden()
        .cursor_pointer().hover((st) => st.border_color(OK)).on_click((_e, cx) => { openTask(p.slug, x.id)(); cx.notify(); })
        .tooltip(`Epic #${x.id} ${x.title} · ${kids.length ? `${done}/${kids.length} tasks done` : "not planned yet"} · ${p.name}`)
        .child(div().flex_none().w(3).h_full().bg(OK))
        .child(v_flex().flex_1().min_w(0).px(T.sp.md).py(T.sp.sm).gap(T.sp.xs)
          .child(h_flex().gap(T.sp.sm).items_center()
            .child(txt(T.text.xs, OK).font_medium().flex_none().child("EPIC"))
            .child(txt(T.text.sm, t.foreground).flex_1().min_w(0).truncate().child(x.title)))
          .child(h_flex().gap(T.sp.sm).items_center()
            .child(tile(p.name, { kind: "project", size: 12, color: p.color }))
            .child(txt(T.text.xs, t.dim).flex_none().child(`#${x.id}`))
            .child(txt(T.text.xs, t.muted).flex_none().child(kids.length ? `${done}/${kids.length} tasks` : "needs plan"))
            .child(div().flex_1())
            .child(agentAvatar(t, x.agent ?? "?", live, 14))));
    }
    const [, pc] = PRIO[x.priority] ?? PRIO.normal;
    return v_flex().id(`mp-dk-b-${p.slug}-${x.id}`).w_full().min_w(0).px(T.sp.md).py(T.sp.sm).gap(T.sp.xs).rounded(T.r.ctrl).bg(t.background).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.border_color(t.input)).on_click((_e, cx) => { openTask(p.slug, x.id)(); cx.notify(); })
      .tooltip(`#${x.id} ${x.title}${x.agent ? ` · ${x.agent}` : ""} · ${p.name}`)
      .child(txt(T.text.sm, t.foreground).truncate().child(x.title))
      .child(h_flex().gap(T.sp.sm).items_center()
        .child(tile(p.name, { kind: "project", size: 12, color: p.color }))
        .child(txt(T.text.xs, t.dim).flex_none().child(`#${x.id}`))
        .when(x.priority === "urgent" || x.priority === "high", (e) => e.child(div().flex_none().size(T.dot).rounded_full().bg(pc)))
        .when(x.status === "doing" && x.progress, (e) => e.child(txt(T.text.xs, t.muted).flex_none().child(`${x.progress}%`)))
        .child(div().flex_1())
        .child(agentAvatar(t, x.agent ?? "?", live, 14)));
  };
  const cols = BOARD.map(([s, lab]) => {
    const items = s === "done" ? by[s].sort((a, b) => ms(b.x.completed) - ms(a.x.completed))
      : by[s].sort((a, b) => (PRI[a.x.priority] ?? 2) - (PRI[b.x.priority] ?? 2) || ms(b.x.started ?? b.x.created) - ms(a.x.started ?? a.x.created));
    const rest = items.slice(BOARD_MAX);
    const top = Object.entries(rest.reduce((m, { p }) => ((m[p.slug] = (m[p.slug] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0];
    return v_flex().flex_1().min_w(0).gap(T.sp.sm)
      .child(h_flex().h(T.h.rowDense - 4).gap(T.sp.sm).items_center()
        .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[s]))
        .child(txt(T.text.xs, t.muted).font_medium().child(lab))
        .child(txt(T.text.xs, t.dim).child(String(items.length))))
      .when(!items.length, (e) => e.child(txt(T.text.xs, t.dim).h(T.h.rowDense).child("—")))
      .children(items.slice(0, BOARD_MAX).map(card))
      .when(rest.length > 0, (e) => e.child(link(t, `mp-dk-bm-${s}`, `+${rest.length} more`, () => { selectProject(top[0], "tasks"); showCenter("mp-view"); })));
  });
  const total = BOARD.reduce((n, [s]) => n + (s === "done" ? 0 : by[s].length), 0);
  // Fixed height (the row's), the columns scroll inside; the wheel over it scrolls only the board.
  return panel(t, "mp-dk-board").flex_1().h_full()
    .child(head(t, "Board", `${total} open across ${S.projects.filter((p) => !p.loose).length} projects`))
    .child(scrollY("mp-dk-board-scroll", (cw >= 640 ? h_flex().w_full().gap(T.sp.lg).items_start().children(cols) : v_flex().w_full().gap(T.sp.lg).children(cols)).pr(T.sp.md))
      .on_scroll_wheel((_e, cx) => cx.stop_propagation()));
}
function machinesPanel(t) {
  const stats = vmStats(), M = S.machines;
  const rows = M.map((m) => ({ m, st: stats[m.name] }));
  const online = rows.filter((r) => r.st?.ok).length;
  const hot = rows.filter((r) => r.st?.ok).sort((a, b) => b.st.cpu - a.st.cpu).slice(0, 3);
  const off = rows.filter((r) => r.st && !r.st.ok);
  const cells = rows.map((r) => ({ key: r.m.name, color: !r.st ? t.raised : r.st.ok ? loadColor(r.st.cpu, t) : `${BAD}33`, outline: r.st && !r.st.ok ? BAD : null,
    tip: `${r.m.name} · ${r.st?.ok ? `CPU ${Math.round(r.st.cpu)}% · RAM ${Math.round(r.st.ram)}% · Disk ${Math.round(r.st.disk)}%` : r.st ? "Offline" : "Checking"}`,
    onClick: () => import("./lib.js").then((l) => l.openVm(r.m.name)) }));
  const line = (r, i) => h_flex().id(`mp-dk-mh-${i}`).h(T.h.rowDense - 4).gap(T.sp.sm).items_center().cursor_pointer()
    .on_click(() => import("./lib.js").then((l) => l.openVm(r.m.name)))
    .child(div().flex_none().size(T.dot).rounded_full().bg(r.st?.ok ? loadColor(Math.max(45, r.st.cpu), t) : BAD))
    .child(txt(T.text.xs, t.muted).flex_1().min_w(0).truncate().hover((s) => s.text_color(t.foreground)).child(r.m.name))
    .child(txt(T.text.xs, r.st?.ok ? (r.st.cpu >= 85 ? BAD : r.st.cpu >= 70 ? WARN : t.dim) : BAD).flex_none().child(r.st?.ok ? `CPU ${Math.round(r.st.cpu)}%` : "Offline"));
  const all = [...off, ...rows.filter((r) => r.st?.ok).sort((a, b) => b.st.cpu - a.st.cpu), ...rows.filter((r) => !r.st)];
  return v_flex().flex_1().min_h(0).gap(T.sp.md)
    .child(head(t, "Machines", M.length ? `${online}/${M.length} online` : "none", link(t, "mp-dk-m-all", "View all", () => setShared("mp.view", { kind: "machines" }))))
    .when(M.length > 0, (e) => e.child(heatGrid(t, "mp-dk-heat", cells, { size: M.length > 60 ? 10 : 14, gap: 3 })))
    // Offline first, then the busiest: the list fills the panel down to the limits and scrolls.
    .when(M.length > 0, (e) => e.child(scrollY("mp-dk-mlist", v_flex().w_full().pr(T.sp.md).children(all.slice(0, 8).map(line))).on_scroll_wheel((_e, cx) => cx.stop_propagation())))
    .when(!M.length, (e) => e.child(txt(T.text.xs, t.dim).child("No machines yet.")));
}
function limits(t) {
  const L = shared("mp.limits");
  const left = (w) => {
    if (!w) return null;
    const reset = w.resets_at ? ms(w.resets_at) : 0;
    return reset && reset < Date.now() ? 100 : Math.max(0, Math.min(100, 100 - (Number(w.used) || 0)));
  };
  const win = (m) => (m === 300 ? "5h" : m === 10080 ? "week" : m >= 40000 ? "month" : m ? `${Math.round(m / 60)}h` : "");
  const all = [];
  if (L?.claude?.ok) all.push(["Claude 5h", left(L.claude.five_hour), CLAUDE], ["Claude week", left(L.claude.seven_day), CLAUDE]);
  if (L?.codex?.ok) all.push([`Codex ${win(L.codex.primary?.window_minutes) || "limit"}`, left(L.codex.primary), CODEX], [`Codex ${win(L.codex.secondary?.window_minutes) || "week"}`, left(L.codex.secondary), CODEX]);
  const shown = all.filter(([, v]) => v != null);
  return v_flex().gap(T.sp.sm)
    .child(head(t, "Limits left"))
    .when(!shown.length, (e) => e.child(txt(T.text.xs, t.dim).child(L ? [L.claude?.err, L.codex?.err].filter(Boolean)[0] ?? "No limit data yet." : "Checking…")))
    .children(shown.map(([lab, v, color]) => {
      const c = v < 15 ? BAD : v < 35 ? WARN : color;
      return h_flex().gap(T.sp.md).items_center()
        .child(txt(T.text.xs, t.dim).w(84).flex_none().truncate().child(lab))
        .child(div().flex_1().h(4).rounded_full().bg(t.border).overflow_hidden().child(div().h_full().w(`${v}%`).rounded_full().bg(c)))
        .child(txt(T.text.xs, v < 35 ? c : t.muted).w(36).flex_none().text_right().child(`${Math.round(v)}%`));
    }));
}

// ------------------------------------------------------------ view
export function dashboardView(ws, t, cx) {
  if (Date.now() - S.at > 6000 && (!S.loading || Date.now() - S.loading > 60000)) refresh(cx);
  const G = rows();
  const ready = G.ready.length;
  const sub = `${G.needs.length ? `${G.needs.length} need${G.needs.length === 1 ? "s" : ""} you` : "Nothing needs you"} · ${G.working.length} working${ready ? ` · ${ready} ready` : ""}`;
  if (S.at && shared("mp.dashSub") !== sub) cx.spawn(async () => setShared("mp.dashSub", sub));
  if (!S.at) return v_flex().w_full().pt(T.sp.lg).child(skeleton(t, 6));
  sample(G);
  const X = series();
  const cw = ws.contentW();
  const wide = cw >= 1000;
  // Needs-you column: ~42% of the page (480-760 px) beside the charts; full width when narrow.
  const leftW = wide ? Math.max(480, Math.min(760, Math.round(cw * 0.42))) : cw;
  S.whoW = leftW >= 640 ? 200 : 150;
  const needs = panel(t, "mp-dk-main").gap(T.sp.sm)
    // Keys come from the center view's focus handle (workspace.js onKey → dashKey).
    .child(tabs(t, G))
    .child(wide ? scrollY("mp-dk-list", v_flex().w_full().pr(T.sp.md).child(list(t, G))).on_scroll_wheel((_e, cx) => cx.stop_propagation()) : list(t, G));
  const chartH = cw >= 1800 ? 220 : 170;
  const small = cw >= 1800 ? 140 : 110;
  const charts = v_flex().flex_1().min_w(0).gap(T.sp.lg)
    .child(activityPanel(t, X, chartH))
    .child((cw >= 760 ? h_flex() : v_flex()).w_full().gap(T.sp.lg).items_start().child(tokensPanel(t, X, small)).child(throughputPanel(t, X, small)));
  const side = panel(t, "mp-dk-side").gap(T.sp.lg).child(machinesPanel(t)).child(div().flex_none().h(1).bg(t.border)).child(div().flex_none().child(limits(t)));
  const BOARD_H = cw >= 1800 ? 560 : 460;
  const skip = Number(shared("mp.devDashSkip")) || 0; // design previews only: hide the first rows to see the rest
  return v_flex().id("mp-dk").w_full().gap(T.sp.lg)
    .when(skip < 1, (e) => e.child(tiles(t, G, X, cw)))
    // Wide: the Needs-you list ends where the charts end (it is laid over its column, so only the charts set
    // the height) and scrolls inside; the board row has a fixed height, the machines panel fills it.
    .when(skip < 2, (e) => e.child(wide ? h_flex().w_full().gap(T.sp.lg).items_stretch()
      .child(div().relative().w(leftW).flex_none().child(needs.absolute().top(0).bottom(0).left(0).right(0)))
      .child(charts) : v_flex().w_full().gap(T.sp.lg).child(needs).child(charts)))
    .child(wide ? h_flex().w_full().h(BOARD_H).gap(T.sp.lg).items_stretch().child(boardPanel(t, cw - 340)).child(side.w(320).flex_none().h_full())
      : v_flex().w_full().gap(T.sp.lg).child(div().h(BOARD_H).child(boardPanel(t, cw))).child(side));
}
