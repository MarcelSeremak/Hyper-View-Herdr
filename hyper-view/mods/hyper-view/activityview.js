// Activity as runs (an agent's session / task as one row, expandable to its key steps), the raw timeline row,
// filters shared with the project Activity view, and the Usage card. Data comes from activity.js.
import { cardHead as cardHeader } from "./ide.js";
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { iconEl, card, empty, clear, fmtTok, fmtTime, colorFor, BAD, OK, WARN, INFO } from "./lib.js";
import { actItems, actTokens, actSession, dayOf, activityError } from "./activity.js";

// kind -> [icon, color, name]
export const KIND = {
  prompt: ["send", "#8aa4c8", "Prompt"], read: ["file-text", "#9aa3ad", "Read"], edit: ["pencil", "#d4a35a", "Edit"], write: ["file-plus", "#7fb08a", "Write"],
  bash: ["terminal", "#79b8b0", "Command"], test: ["flask", "#a593c2", "Test"], search: ["search", "#9aa3ad", "Search"], web: ["globe", "#6f9fd0", "Web"],
  mcp: ["webhook", "#c48aa3", "MCP"], agent: ["bot", "#8aa4c8", "Subagent"], tool: ["zap", "#9aa3ad", "Tool"], error: ["alert", BAD, "Error"],
  compact: ["layers", "#9aa3ad", "Compaction"], commit: ["git", "#c98a62", "Git"], message: ["messages", INFO, "Message"], task: ["check-square", "#a3b7d4", "Task"],
};
export const FILTERS = [["all", "All"], ["edits", "Edits"], ["cmds", "Commands"], ["tests", "Tests"], ["errors", "Errors"], ["msgs", "Messages"]];
export const matches = (f, x) => f === "all"
  || (f === "edits" && (x.k === "edit" || x.k === "write"))
  || (f === "cmds" && (x.k === "bash" || x.k === "commit" || x.k === "test"))
  || (f === "tests" && x.k === "test")
  || (f === "errors" && (x.k === "error" || x.x === "fail"))
  || (f === "msgs" && (x.k === "prompt" || x.k === "message" || x.k === "task"));
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(day) {
  if (day === dayOf(Date.now())) return "Today";
  if (day === dayOf(Date.now() - 86400000)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${y !== new Date().getFullYear() ? `, ${y}` : ""}`;
}
const live = (x) => x.x === "run" && Date.now() - x.t < 15 * 60 * 1000;

// hp events of this agent (messages, tasks, remote commands) as timeline items; name null = every agent
// of the project (item.a = the agent it belongs to, for the project-wide Activity view).
export function hpItems(events, name) {
  const out = [];
  for (const e of events) {
    if (name ? e.from !== name && e.to !== name : e.from === "hp" || e.type === "system") continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (e.type === "message") {
      const who = e.from === name ? (e.to && e.to !== "all" ? `To ${e.to === "ty" ? "you" : e.to}` : "To team") : `From ${e.from === "ty" ? "you" : e.from}`;
      const all = !name;
      const label = all ? `${e.to && e.to !== "all" ? `To ${e.to === "ty" ? "you" : e.to}` : "To team"}: ` : `${who}: `;
      out.push({ t, k: "message", l: `${label}${String(e.text ?? "").replace(/\s+/g, " ")}`, s: "hp", task: e.task, a: e.from, to: e.to, txt: String(e.text ?? "").replace(/\s+/g, " ") });
    } else if (e.type === "task") out.push({ t, k: "task", l: String(e.text ?? ""), s: "hp", task: e.task, a: e.from });
    else if (e.type === "tool" && (!name || e.from === name)) out.push({ t, k: "bash", l: String(e.text ?? ""), s: "hp", a: e.from });
  }
  return out;
}

// ------------------------------------------------------------ runs
// Thousands of steps read as a few dozen runs: one run = one session of one agent, split when it switches
// task (hp task events) or after 30 min of silence. hp messages / task events join the run they fall in.
// A run: { id, a, sid, first, last, task, prompt, steps (oldest first), edits, cmds, errors, tests, commits,
// files: [[path, n]], lastMsg, outcome: [label, color, icon], live }.
const GAP = 30 * 60 * 1000;
const RUNS = (globalThis.__hvRuns ??= new Map());
const taskIdOf = (x) => (x.task != null && x.task !== "" ? String(x.task) : null);
const fileOf = (l) => String(l ?? "").replace(/^(Edit|Write|Delete)\s+/, "").replace(/\s*\(.*\)\s*$/, "").trim();

export function buildRuns(items, p, liveOf) {
  const key = `${p.slug}|${items.length}|${items[0]?.t ?? 0}|${items[items.length - 1]?.t ?? 0}|${p.tasks?.length ?? 0}`;
  const hit = RUNS.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.runs;
  const asc = [...items].sort((a, b) => a.t - b.t);
  const runs = [];
  const open = new Map(); // agent -> current run
  for (const x of asc) {
    // Your own messages belong to the run of the agent they went to (team messages: no run of their own).
    const a = x.a === "ty" ? (x.to && x.to !== "all" && x.to !== "ty" ? x.to : null) : x.a ?? "unknown";
    if (!a) continue;
    let r = open.get(a);
    const sid = x.s && x.s !== "hp" ? x.s : null;
    const tid = taskIdOf(x);
    const fresh = !r || x.t - r.last > GAP || (sid && r.sid && sid !== r.sid) || (x.k === "task" && tid && r.task && tid !== r.task);
    if (fresh) { r = { id: `${a}:${x.t}`, a, sid, first: x.t, last: x.t, task: null, steps: [] }; runs.push(r); open.set(a, r); }
    if (sid && !r.sid) r.sid = sid;
    if (tid && !r.task) r.task = tid;
    r.steps.push(x);
    r.last = Math.max(r.last, x.t + (x.d ?? 0));
  }
  const tasks = new Map((p.tasks ?? []).map((x) => [String(x.id), x]));
  const lastOf = new Map();
  for (const r of runs) lastOf.set(r.a, r);
  for (const r of runs) {
    let edits = 0, cmds = 0, errors = 0, test = null, commits = 0, running = false, lastMsg = null, prompt = null, ask = null;
    const files = new Map();
    for (const x of r.steps) {
      if (x.k === "edit" || x.k === "write") { edits++; const f = fileOf(x.l); if (f) files.set(f, (files.get(f) ?? 0) + 1); }
      if (x.k === "bash" || x.k === "test" || x.k === "commit") cmds++;
      if (x.k === "error" || x.x === "fail") errors++;
      if (x.k === "test" && x.x !== "run") test = x;
      if (x.k === "commit" && x.x !== "fail") commits++;
      if (x.x === "run" && Date.now() - x.t < 15 * 60 * 1000) running = true;
      if (x.k === "message" && x.a === r.a) lastMsg = x.l;
      if (!prompt && x.k === "prompt") prompt = x.l;
      if (!ask && x.k === "message" && x.a === "ty") ask = x.txt ?? x.l;
    }
    if (!r.task && prompt) { const m = /#(\d+)\b/.exec(prompt); if (m && tasks.has(m[1])) r.task = m[1]; }
    const tk = r.task ? tasks.get(String(r.task)) : null;
    r.title = tk ? `#${tk.id} ${tk.title}` : r.task ? `#${r.task}` : prompt ?? ask ?? (((m) => m?.txt ?? m?.l)(r.steps.find((x) => x.k === "message"))) ?? r.steps[0]?.l ?? "Run";
    r.taskObj = tk ?? null;
    const live = lastOf.get(r.a) === r ? liveOf?.(r.a) : null;
    if (live?.status === "working" && Date.now() - r.last < 10 * 60 * 1000) running = true;
    const lastStep = r.steps[r.steps.length - 1];
    Object.assign(r, { edits, cmds, errors, commits, test, files: [...files].sort((x, y) => y[1] - x[1]).slice(0, 5), live: running,
      lastMsg: ((m) => (m && !String(m).endsWith(r.title) ? m : ""))(lastMsg ?? lastStep?.l) });
    r.outcome = running ? ["running", OK, "loader"]
      : live?.status === "blocked" ? ["waiting for you", WARN, "clock"]
      : test?.x === "fail" || lastStep?.k === "error" ? ["failed", BAD, "x"]
      : tk?.status === "done" ? ["done", OK, "check"]
      : commits ? ["committed", OK, "git"]
      : test?.x === "ok" ? ["tests passed", OK, "check"]
      : ["ended", null, "square"];
  }
  runs.reverse();
  if (RUNS.size > 40) RUNS.clear();
  RUNS.set(key, { at: Date.now(), runs });
  return runs;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Small dim counters: edits, commands, errors (errors in red).
function counts(t, r) {
  const c = (ic, n, color, tip) => h_flex().flex_none().gap(T.sp.xxs).items_center().child(iconEl(ic, color ?? t.dim, 11))
    .child(div().text_size(T.text.xs).text_color(color ?? t.dim).child(String(n)));
  return h_flex().flex_none().gap(T.sp.md).items_center()
    .when(r.edits > 0, (e) => e.child(c("pencil", r.edits)))
    .when(r.cmds > 0, (e) => e.child(c("terminal", r.cmds)))
    .when(r.errors > 0, (e) => e.child(c("alert", r.errors, BAD)));
}
// The key steps of a run: prompts, commits, tests, errors, messages, task changes (newest last).
const KEY_KINDS = new Set(["prompt", "commit", "test", "error", "message", "task"]);
export const keySteps = (r) => r.steps.filter((x) => KEY_KINDS.has(x.k) || x.x === "fail");

// One run: two lines (title + outcome · last message), expandable to its key steps and edited files.
// opts: { showAgent, open (bool), onToggle(cx), onAll(r), onTask(id), idp, sel }
export function runRow(t, r, opts) {
  const { showAgent = false, open = false, idp = "mp-run", sel = false } = opts;
  const [oLabel, oColor, oIcon] = r.outcome;
  const dur = r.last - r.first >= 1000 ? fmtDur(r.last - r.first) : "";
  const head = h_flex().id(`${idp}-${r.id}`).w_full().py(T.sp.sm).px(T.sp.md).gap(T.sp.md).items_start().rounded(T.r.ctrl).cursor_pointer()
    .when(sel, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { opts.onToggle?.(cx); cx.notify(); })
    .child(h_flex().flex_none().mt(2).size(16).items_center().justify_center()
      .child(r.live ? div().size(8).rounded_full().bg(OK).loop("opacity", { from: 0.35, to: 1, period: 1200 }) : iconEl(oIcon, oColor ?? t.dim, 13)))
    .child(v_flex().flex_1().min_w(0).gap(T.sp.xxs)
      .child(h_flex().min_w(0).gap(T.sp.md).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.foreground).child(String(r.title)))
        .child(counts(t, r))
        .child(div().flex_none().w(56).text_right().text_size(T.text.xs).text_color(t.dim).child(r.live ? "" : dur))
        .child(div().flex_none().w(40).text_right().text_size(T.text.xs).text_color(t.dim).child(fmtTime(r.last))))
      .child(h_flex().min_w(0).gap(T.sp.sm).items_center().text_size(T.text.xs)
        .when(showAgent, (e) => e.child(h_flex().flex_none().gap(T.sp.xs).items_center()
          .child(div().size(T.dot).rounded_full().bg(colorFor(`agent:${r.a}`))).child(div().text_color(t.muted).child(r.a))).child(div().text_color(t.dim).child("·")))
        .child(div().flex_none().text_color(oColor ?? t.muted).child(oLabel))
        .when(Boolean(r.lastMsg), (e) => e.child(div().text_color(t.dim).child("·")).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(String(r.lastMsg))))))
    .child(div().flex_none().mt(2).child(iconEl(open ? "chevron-down" : "chevron-right", t.dim, 12)));
  if (!open) return head;
  const ks = keySteps(r);
  const shown = ks.slice(-12);
  return v_flex().w_full().child(head)
    .child(v_flex().ml(T.sp.md + 16 + T.sp.md).mr(T.sp.md).mb(T.sp.sm).pl(T.sp.md).border_l_1().border_color(t.border)
      .when(ks.length > shown.length, (e) => e.child(div().h(20).text_size(T.text.xs).text_color(t.dim).child(`${ks.length - shown.length} earlier key steps`)))
      .when(shown.length === 0, (e) => e.child(div().h(20).text_size(T.text.xs).text_color(t.dim).child("No commits, tests, errors or messages in this run.")))
      .children(shown.map((x, i) => timelineRow(t, x, `${idp}-${r.id}-k${i}`, opts.onTask)))
      .when(r.files.length > 0, (e) => e.child(h_flex().min_h(24).gap(T.sp.sm).items_center().flex_wrap()
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("Edited"))
        .children(r.files.map(([f, n], i) => h_flex().id(`${idp}-${r.id}-f${i}`).flex_none().h(18).px(T.sp.sm).gap(T.sp.xs).items_center().rounded(T.r.chip).bg(t.raised).tooltip(f)
          .child(div().max_w(220).truncate().text_size(T.text.xs).text_color(t.muted).child(shortFile(f)))
          .when(n > 1, (x) => x.child(div().text_size(T.text.xs).text_color(t.dim).child(`×${n}`)))))))
      .child(h_flex().id(`${idp}-${r.id}-all`).h(24).gap(T.sp.xs).items_center().cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { opts.onAll?.(r); cx.notify(); })
        .child(div().text_size(T.text.xs).font_medium().text_color(t.accent).hover((s) => s.opacity(0.8)).child(`All ${plural(r.steps.length, "step")}`))
        .child(iconEl("chevron-right", t.accent, 11))));
}
const shortFile = (f) => { const parts = String(f).split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : String(f); };

export function timelineRow(t, x, id, onTask) {
  const [ic, color, kname] = KIND[x.k] ?? KIND.tool;
  const fail = x.x === "fail" || x.k === "error";
  const running = live(x);
  return h_flex().id(id).h(24).gap(8).items_center().rounded(T.r.chip).px(4).hover((s) => s.bg(t.hover))
    .tooltip(`${kname}${x.x === "fail" ? " (failed)" : ""} · ${new Date(x.t).toLocaleString()}${x.d ? ` · ${fmtDur(x.d)}` : ""}\n${x.l}`)
    .when(Boolean(x.task && onTask), (el) => el.cursor_pointer().on_click(() => onTask(x.task)))
    .child(iconEl(ic, fail ? BAD : color, 13))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(fail ? BAD : x.k === "prompt" || x.k === "message" ? t.foreground : t.muted).child(x.l))
    .when(running, (el) => el.child(h_flex().flex_none().gap(4).items_center()
      .child(div().size(T.dot).rounded_full().bg(OK)).child(div().text_size(T.text.xs).text_color(OK).child("running"))))
    .child(div().flex_none().w(52).text_right().text_size(T.text.xs).text_color(t.dim).child(running ? "" : fmtDur(x.d)))
    .child(div().flex_none().w(36).text_right().text_size(T.text.xs).text_color(t.dim).child(fmtTime(x.t)));
}

// Usage: tokens today / 7 days / total, last 14 days as bars, and per model.
export function usageCard(t, p, a, fallback) {
  const tk = actTokens(p.slug, a.name);
  const tot = (v) => v[0] + v[1] + v[2] + v[3];
  const total = tk.has ? tot(tk.total) : fallback ?? 0;
  const color = a.app === "codex" ? "#6aa58f" : "#c98a6c";
  const days = Array.from({ length: 14 }, (_, i) => { const d = dayOf(Date.now() - (13 - i) * 86400000); return { d, n: tk.byDay[d] ? tot(tk.byDay[d]) : 0 }; });
  const max = Math.max(1, ...days.map((x) => x.n));
  const stat = (label, v, tip) => v_flex().id(`mp-ad-u-${label}`).flex_1().min_w(0).gap(1).when(Boolean(tip), (el) => el.tooltip(tip))
    .child(div().text_size(T.text.xs).text_color(t.dim).child(label))
    .child(div().text_size(T.text.lg).font_semibold().child(fmtTok(v)));
  const split = (v) => `Input ${fmtTok(v[0])} · Output ${fmtTok(v[1])} · Cache read ${fmtTok(v[2])} · Cache write ${fmtTok(v[3])}`;
  const models = Object.entries(tk.models).map(([m, v]) => [m, tot(v)]).filter(([, n]) => n).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return card(t, "mp-ad-usage").child(cardHeader(t, "Usage", null, tk.errorsToday ? `${tk.errorsToday} error${tk.errorsToday === 1 ? "" : "s"} today` : null))
    .child(h_flex().px(12).pb(12).gap(8)
      .child(stat("Today", tk.has ? tot(tk.today) : 0, tk.has ? split(tk.today) : null))
      .child(stat("7 days", tk.has ? tot(tk.d7) : 0, tk.has ? split(tk.d7) : null))
      .child(stat("Total", total, tk.has ? split(tk.total) : null)))
    .when(tk.has, (el) => el
      .child(h_flex().id("mp-ad-u-bars").mx(12).h(32).gap(2).items_end().children(days.map((x, i) =>
        v_flex().id(`mp-ad-u-b${i}`).flex_1().min_w(0).h_full().justify_end().tooltip(`${dayLabel(x.d)} · ${fmtTok(x.n)} tokens`)
          .child(div().w_full().h(x.n ? `${Math.max(6, Math.round((100 * x.n) / max))}%` : 2).rounded(2).bg(x.n ? (i === 13 ? color : `${color}99`) : t.hover)))))
      .child(h_flex().mx(12).mt(4).justify_between().text_size(T.text.xs).text_color(t.dim).child(div().child("14 days")).child(div().child("Today"))))
    .child(v_flex().px(12).pt(8).pb(12).gap(4).children(models.map(([m, n]) =>
      h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(m))
        .child(div().flex_none().text_size(T.text.xs).child(fmtTok(n)))))
      .when(!tk.has && !total, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child("No sessions recorded yet."))));
}
