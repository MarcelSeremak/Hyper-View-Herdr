// Mailbox: everything that waits for you across projects — approvals and questions addressed to "ty",
// blocked tasks and tasks in review, messages, and the daily report ("herdr" → ty, thread "daily-<date>").
// Triage like Linear Inbox / Superhuman: grouped by importance (Approvals → Questions → Blocked → Review →
// Messages → Reports), one key per action (A approve, X reject, R reply, E done, S snooze, Enter open),
// snooze with fixed choices (1 hour / This evening / Tomorrow 9:00 / Next week) after which the item comes back.
// Done ids and snoozes are kept in ~/.herdr/mailbox.json (outside the layout folder, also written in demo mode):
//   { "done": [id...], "notify": true, "snooze": { "<id>": "<ISO time it comes back>" } }
// Snoozed items count nowhere (mp.mailboxN, project badges, attention, notifications) until they come back.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { readTextFile, writeTextFile, setShared, shared } from "herdr";
import {
  herdrHome, listProjects, loadProject, loadEvents, liveAgent, startAgent, selectProject, showCenter, hp, toast, demo,
  agentAvatar, iconEl, iconButton, card, clear, OK, BAD, WARN, INFO, TASK_EN, TASK_COLOR,
} from "./lib.js";
import { openTaskPanel } from "./taskpanel.js";
import { relTime, hoverAction, trackHover, hovered, emptyLine, skeleton, kbd } from "./ide.js";

const file = () => `${herdrHome()}/mailbox.json`;
export const ASK = /\?|\bodpowiedz\b|\breply\b/i;
const REPORT = /^daily-/;
const now = () => Date.now();
const live = (snooze) => Object.fromEntries(Object.entries(snooze ?? {}).filter(([, u]) => new Date(u).getTime() > now()));

async function readState() {
  const text = await readTextFile(file()).catch(() => null);
  try {
    const o = text ? JSON.parse(text.replace(/^﻿/, "")) ?? {} : {};
    return { text, done: o.done ?? [], notify: o.notify !== false, snooze: o.snooze && typeof o.snooze === "object" ? o.snooze : {} };
  } catch { return { text, done: [], notify: true, snooze: {} }; }
}
// Read-modify-write with the snapshot check writeTextFile gives us (same as clipboard.js).
async function changeFile(fn) {
  for (let i = 0; i < 3; i++) {
    const { text, done, notify, snooze } = await readState();
    const next = fn({ done, notify, snooze });
    const out = { done: [...next.done].slice(-3000), notify: next.notify, snooze: live(next.snooze) }; // expired snoozes dropped
    try { await writeTextFile(file(), JSON.stringify(out, null, 2), text ?? null); return true; } catch {}
  }
  return false;
}
const changeDone = (fn) => changeFile((o) => ({ ...o, done: fn(new Set(o.done)) }));
const changeSnooze = (fn) => changeFile((o) => ({ ...o, snooze: fn({ ...o.snooze }) }));
// Notifications on/off (the bell in the Mailbox): shared("mp.mbNotify"), persisted as mailbox.json "notify".
export const notifyOn = () => shared("mp.mbNotify") !== false;
function publishNotify(on) { if (shared("mp.mbNotify") !== on) setShared("mp.mbNotify", on); }
async function setNotify(on) {
  publishNotify(on);
  if (!(await changeFile((o) => ({ ...o, notify: on })))) toast("Could not save", "The mailbox file changed; try again.", "error");
}

// Demo mode: an approval request and today's daily report, so triage can be tried (nothing is sent).
function demoExtras(projects) {
  const p = projects.find((x) => x.slug === "demo-ecommerce") ?? projects.find((x) => !x.loose) ?? projects[0];
  if (!p) return [];
  const day = new Date().toISOString().slice(0, 10);
  const at = (m) => new Date(now() - m * 60000).toISOString();
  return [
    { id: `${p.slug}:demo-approval-7`, slug: p.slug, proj: p, kind: "approval", approvalId: "7", from: "deploy-agent", ts: at(4), task: 1,
      text: "Approval #7: run migration 0042 on db-primary (adds an index, ~2 min table lock)", auto: false },
    { id: `${p.slug}:demo-epic-plan-8`, slug: p.slug, proj: p, kind: "approval", approvalId: "8", epicPlan: true, from: "deploy-agent", ts: at(2), task: 18,
      text: "Approval #8: Epic plan #18 Move billing to the EU region: 3 tasks - #19 Provision billing DB in eu-central-1 (deploy-agent); #20 Copy billing data and verify checksums (research-agent, after #19); #21 Point billing workers at the EU database (comm-agent, after #20)", auto: false },
    { id: `${p.slug}:demo-report-${day}`, slug: p.slug, proj: p, kind: "report", thread: `daily-${day}`, from: "herdr", ts: at(9), auto: false,
      text: `Daily report ${day}: 3 tasks done, 2 in review, 1 blocked. deploy-agent shipped the API to staging (smoke tests 78%).\n`
        + "research-agent found a CPU spike on the API at peak hours; task #5 (optimize DB queries) is queued, urgent.\n"
        + "comm-agent is blocked on #4 (share results with the team) waiting for your answer.\n"
        + "Tokens: 514k today (Codex month 100%). Machines: 5/6 online, monitor-01 offline since 06:10." },
  ];
}

// All items for every project (loose agents included), newest first.
// done: ids that do not count right now (done or snoozed) — what dashboard, attention and the notifier skip.
// doneIds: only the ones marked done. snooze: { id: ISO time } still in the future.
export async function loadMailbox() {
  const [projects, { done, notify: notifyPref, snooze: snoozeAll }] = await Promise.all([listProjects(), readState()]);
  publishNotify(notifyPref);
  const doneSet = new Set(done);
  const snooze = live(snoozeAll);
  const items = [];
  const projs = [];
  for (const p0 of projects) {
    const slug = p0.slug;
    const full = await loadProject(slug);
    const events = await loadEvents(slug);
    const proj = { ...p0, tasks: full?.tasks ?? [] };
    projs.push(proj);
    events.forEach((e, i) => {
      // Daily report: a direct message from "herdr" in thread daily-<date> (written by the report agent).
      if (e.from === "herdr" && REPORT.test(String(e.thread ?? "")) && e.type === "message" && (!e.to || e.to === "ty" || e.to === "all")) {
        items.push({ id: `${slug}:${e.id ?? e.ts}`, slug, proj, kind: "report", thread: e.thread, from: "herdr", text: e.text ?? "", ts: e.ts, auto: false });
        return;
      }
      if (e.to !== "ty" || e.from === "ty" || (e.type !== "message" && e.type !== "task" && e.type !== "approval")) return;
      // Approval request (hp ask / --ask): answered only by "Approved #N" / "Rejected #N" (hp approve|reject).
      const apId = e.type === "approval" ? /^Approval #(\d+)/.exec(e.text ?? "")?.[1] : null;
      if (e.type === "approval") {
        const answeredAp = events.slice(i + 1).some((x) => x.from === "ty" && x.to === e.from && new RegExp(`^(Approved|Rejected) #${apId}\\b`).test(x.text ?? ""));
        items.push({ id: `${slug}:${e.id ?? e.ts}`, slug, proj, kind: "approval", approvalId: apId, from: e.from, text: e.text ?? "", ts: e.ts, task: e.task, auto: answeredAp,
          epicPlan: /^Approval #\d+: Epic plan #/.test(e.text ?? "") });
        return;
      }
      // Already answered: you wrote to that agent afterwards.
      const answered = events.slice(i + 1).some((x) => x.from === "ty" && x.to === e.from);
      // Plain messages (reports, "done", "noted") stay in the chat; only questions come to the Mailbox.
      if (!ASK.test(e.text ?? "")) return;
      items.push({ id: `${slug}:${e.id ?? e.ts}`, slug, proj, kind: "ask", from: e.from, text: e.text ?? "", ts: e.ts, task: e.task, auto: answered });
    });
    // Tasks: only blocked ones that wait for Marcel. Not: Review (another agent reviews it), blocked on another
    // task ("waiting for #N", hp's dependency text), or blocked on a question / approval already in the list.
    const asked = new Set(items.filter((it) => it.slug === slug && (it.kind === "ask" || it.kind === "approval") && it.task != null).map((it) => String(it.task)));
    for (const x of proj.tasks) {
      if (x.status !== "blocked") continue;
      if (/^\s*waiting for #\d+/i.test(x.blocked_reason ?? "")) continue;
      if (asked.has(String(x.id))) continue;
      const last = x.history?.length ? x.history[x.history.length - 1].ts : x.started ?? x.created;
      // Answered: you wrote to its agent about this task after it got blocked (the agent unblocks it).
      const answered = x.status === "blocked" && events.some((e) => e.from === "ty" && e.to === x.agent && String(e.task ?? "") === String(x.id) && String(e.ts) > String(last));
      items.push({ id: `${slug}:task:${x.id}:${x.status}`, slug, proj, kind: "task", from: x.agent ?? "?", taskId: x.id, task: x.id, status: x.status,
        title: x.title, reason: x.blocked_reason ?? "",
        text: `#${x.id} ${x.title}${x.status === "blocked" && x.blocked_reason ? " — " + x.blocked_reason : ""}`, ts: last, auto: answered });
    }
  }
  if (demo()) items.push(...demoExtras(projs));
  items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const inactive = new Set([...doneSet, ...Object.keys(snooze)]);
  const openItems = items.filter((it) => !it.auto && !inactive.has(it.id));
  const open = openItems.length;
  const bySlug = {};
  for (const it of openItems) bySlug[it.slug] = (bySlug[it.slug] ?? 0) + 1;
  if (JSON.stringify(shared("mp.mailboxBySlug") ?? {}) !== JSON.stringify(bySlug)) setShared("mp.mailboxBySlug", bySlug);
  return { items, done: inactive, doneIds: doneSet, snooze, open };
}
export function publishCount(n) { if (shared("mp.mailboxN") !== n) setShared("mp.mailboxN", n); }

const S = { items: [], done: new Set(), snooze: {}, filter: "open", replyId: null, input: null, openId: null, snoozeId: null, loading: false, at: 0 };
const isDone = (it) => it.auto || S.done.has(it.id);
const snoozedUntil = (it) => { const u = S.snooze[it.id]; return u && new Date(u).getTime() > now() ? u : null; };
const isOpen = (it) => !isDone(it) && !snoozedUntil(it);
const countOpen = () => S.items.filter(isOpen).length;
// Importance order (Linear groups / Superhuman split inbox): what blocks an agent first, FYI last.
// One list: everything that waits for you is an "Approval" (approval requests, questions, blocked and review
// tasks, reports), newest first; each row keeps its own buttons (Approve / Reject, Reply, Answer).
const GROUPS = [["all", "Approvals", WARN]];
const groupOf = () => "all";

// S.loading = start time: a load whose task was dropped (the view rebuilt mid-load) no longer blocks the
// next one for ever (the Mailbox used to stay on its skeleton until a restart).
function refresh(cx) {
  S.loading = now();
  cx.spawn(async (cx) => {
    try { const r = await loadMailbox(); S.items = r.items; S.done = r.doneIds; S.snooze = r.snooze; publishCount(r.open); } catch {}
    S.at = now(); S.loading = 0;
    cx.notify();
  });
}
function setDone(cx, it, on) {
  if (on) S.done.add(it.id); else S.done.delete(it.id);
  if (S.replyId === it.id) S.replyId = null;
  if (S.snoozeId === it.id) S.snoozeId = null;
  publishCount(countOpen());
  cx.notify();
  cx.spawn(async () => { if (!(await changeDone((set) => { if (on) set.add(it.id); else set.delete(it.id); return set; }))) toast("Could not save", "The mailbox file changed; try again.", "error"); });
}

// Snooze choices (Linear: an hour, tomorrow, next week; Superhuman: later today, this evening).
const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;
const whenLabel = (iso) => {
  const d = new Date(iso), t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - t0) / 86400000);
  return days === 0 ? `today ${hm(d)}` : days === 1 ? `tomorrow ${hm(d)}` : `${DAYS[d.getDay()]} ${hm(d)}`;
};
function snoozeChoices() {
  const d = new Date();
  const at = (days, h) => { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(h, 0, 0, 0); return x; };
  const evening = d.getHours() < 17 ? at(0, 18) : d.getHours() < 20 ? at(0, 21) : null;
  const monday = at(((8 - d.getDay()) % 7) || 7, 9);
  return [
    ["1h", "1 hour", new Date(d.getTime() + 3600000)],
    evening && ["eve", "This evening", evening],
    ["tom", "Tomorrow 9:00", at(1, 9)],
    ["week", "Next week", monday],
  ].filter(Boolean).map(([k, label, date]) => ({ k, label, until: date.toISOString() }));
}
function setSnooze(cx, it, until) {
  if (until) S.snooze[it.id] = until; else delete S.snooze[it.id];
  S.snoozeId = null;
  if (S.replyId === it.id) S.replyId = null;
  publishCount(countOpen());
  if (until) toast("Snoozed", `Back ${whenLabel(until)}`, "info");
  cx.notify();
  cx.spawn(async () => { if (!(await changeSnooze((m) => { if (until) m[it.id] = until; else delete m[it.id]; return m; }))) toast("Could not save", "The mailbox file changed; try again.", "error"); });
}
function toggleSnoozeMenu(cx, it) {
  if (isDone(it)) return;
  if (snoozedUntil(it)) { setSnooze(cx, it, null); toast("Unsnoozed", "Back in Open", "info"); return; }
  S.snoozeId = S.snoozeId === it.id ? null : it.id;
  S.replyId = null;
  cx.notify();
}

function say(cx, it, text) {
  if (demo()) toast(`Sent to ${it.from}`, "Demo mode: nothing was sent.", "success");
  else cx.spawn(async () => {
    const p = it.proj;
    const to = p.loose ? p.agents[0]?.name ?? it.from : it.from;
    const r = await hp(["say", it.kind === "task" ? `Answer for blocked #${it.taskId}: ${text}` : text], { p: it.slug, as: "ty", to, task: it.task ? String(it.task) : undefined });
    if (r.ok) toast(`Sent to ${to}`, it.kind === "task" ? `#${it.taskId}: it continues when it reads it.` : "", "success");
    if (r.ok && p.loose && p.agents[0] && !liveAgent(p, p.agents[0].name)) startAgent(p, p.agents[0], text);
    if (!r.ok) toast("Message not sent", r.err, "error");
  });
  setDone(cx, it, true);
}
// Approval requests: hp approve|reject <id> records the answer (the agent then re-runs with --approved <id>)
// and sends "Approved #N" / "Rejected #N" to the agent.
// Epic plans (hp epic submit): Approve moves the epic's tasks to To Do; Revise asks for a note (the reply line)
// and sends it back to the lead (hp reject --note).
function decide(cx, it, verb, note) {
  if (demo()) toast(verb === "approve" ? `Approved #${it.approvalId}` : it.epicPlan ? `Plan #${it.approvalId} sent back` : `Rejected #${it.approvalId}`, "Demo mode: nothing was sent.", "success");
  else cx.spawn(async () => {
    const r = await hp([verb, String(it.approvalId)], { p: it.slug, as: "ty", note: note || undefined });
    if (!r.ok) toast(verb === "approve" ? "Not approved" : "Not rejected", r.err, "error");
  });
  setDone(cx, it, true);
}
// A / X: approve or reject an approval request, or answer a question with a yes / no.
// Approve / Reject only for real approval requests (hp ask: one command, once); questions are answered with Reply.
const canDecide = (it) => isOpen(it) && it.kind === "approval" && it.approvalId;
function approve(cx, it) { if (!canDecide(it)) return; if (it.kind === "approval") decide(cx, it, "approve"); else say(cx, it, "Approved. Go ahead."); }
function reject(cx, it) {
  if (!canDecide(it)) return;
  if (it.epicPlan) { reply(it); S.reviseId = it.id; return; } // Revise: type what to change, Enter sends it
  if (it.kind === "approval") decide(cx, it, "reject"); else say(cx, it, "Rejected. Do not do it; tell me the alternative.");
}
// Blocked tasks are answered like questions: the reply goes to its agent with the task number (it unblocks it).
const canReply = (it) => !isDone(it) && it.kind !== "report" && (it.kind !== "task" || it.status === "blocked");
function reply(it) {
  if (!canReply(it)) return;
  S.reviseId = null;
  S.replyId = it.id; S.snoozeId = null;
  const inp = replyInput(); inp.set_value(""); inp.focus();
}
function openTaskOf(it) { selectProject(it.slug, "tasks"); openTaskPanel(it.slug, it.taskId); showCenter("mp-view"); }
function openItem(it) {
  if (it.kind === "task" && it.status !== "blocked") openTaskOf(it);
  // Everything else opens in place: the full text (an epic plan as its list of tasks, an approval with its command).
  else S.openId = S.openId === it.id ? null : it.id;
}
function replyInput() {
  if (!S.input) {
    S.input = InputState.new({ placeholder: "Reply…" });
    S.input.on("submit", (_e, cx) => sendReply(cx));
  }
  return S.input;
}
function sendReply(cx) {
  const it = S.items.find((x) => x.id === S.replyId);
  const text = S.input?.value().trim();
  if (!it || !text) return;
  S.input.set_value("");
  if (S.reviseId === it.id) { S.reviseId = null; S.replyId = null; decide(cx, it, "reject", text); return; }
  say(cx, it, text);
}

// Decision buttons (approve / reject) stay visible: outlined, colored text, no tinted fill; key chip on hover.
const small = (t, id, label, color, onClick, key) => h_flex().id(id).flex_none().h(22).pl(8).pr(key ? 4 : 8).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer()
  .border_1().border_color(t.border).text_color(color).text_size(T.text.xs).font_medium().hover((s) => s.bg(t.hover).border_color(t.input))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label).when(Boolean(key), (e) => e.child(kbd(t, key)));

function row(t, it, key) {
  const done = isDone(it);
  const until = snoozedUntil(it);
  const liveA = it.kind === "report" ? null : liveAgent(it.proj, it.from);
  const k = `mp-mb-${key}`;
  const hot = hovered("mb", k);
  const actions = h_flex().flex_none().gap(4).items_center();
  if (canDecide(it)) actions
    .child(small(t, `${k}-ok`, "Approve", OK, (cx) => approve(cx, it), hot ? "A" : null))
    .child(small(t, `${k}-no`, it.epicPlan ? "Revise" : "Reject", it.epicPlan ? WARN : BAD, (cx) => reject(cx, it), hot ? "X" : null));
  // Questions, messages and blocked tasks: always an answer button (the agent continues when you answer).
  // Everything open can be answered in words too: approvals and questions get Reply next to Approve / Reject
  // (e.g. "yes, but only on TEST"; a plain Approve / Reject still decides the approval itself).
  if (canReply(it)) actions.child(small(t, `${k}-re`, it.kind === "task" ? "Answer" : "Reply", INFO, () => { if (S.replyId === it.id) S.replyId = null; else reply(it); }, hot ? "R" : null));
  if (hot && it.kind === "task") actions.child(hoverAction(t, `${k}-task`, "Task", () => openTaskOf(it), null));
  if (hot && it.kind !== "task") actions.child(hoverAction(t, `${k}-open`, S.openId === it.id ? "Close" : "Read", () => openItem(it), "↵"));
  if (hot && !done) actions.child(hoverAction(t, `${k}-sz`, until ? "Unsnooze" : "Snooze", (cx) => toggleSnoozeMenu(cx, it), "S"));
  const check = it.auto
    ? h_flex().id(`${k}-chk`).flex_none().size(20).items_center().justify_center().tooltip("Answered").child(iconEl("check", t.dim, 12))
    : h_flex().id(`${k}-chk`).flex_none().size(20).rounded_full().items_center().justify_center().cursor_pointer()
      .border_1().border_color(done ? OK : t.border).bg(done ? `${OK}26` : clear).hover((s) => s.border_color(OK))
      .tooltip(done ? "Mark open (E)" : "Mark done (E)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => setDone(cx, it, !done))
      .child(iconEl("check", done ? OK : t.dim, 12));
  const avatar = it.kind === "report"
    ? h_flex().flex_none().size(18).rounded_full().items_center().justify_center().bg(t.raised).child(iconEl("file-text", t.muted, 11))
    : agentAvatar(t, it.from, liveA, 18);
  const pname = it.proj?.loose ? "loose" : it.proj?.name ?? it.slug;
  // One 32px line per item (Linear Inbox): avatar, sender, text (full text on hover), project, actions, time, done.
  const text = it.kind === "task" ? `${TASK_EN[it.status]} · ${it.text}` : it.kind === "report" ? String(it.text).split("\n")[0] : it.text;
  // Clicking the line reads it (opens the full text below it); the buttons keep their own clicks.
  const main = trackHover(h_flex().id(k).h(T.h.row).px(12).gap(8).items_center().cursor_pointer().on_click((_e, cx) => { openItem(it); cx.notify(); }), "mb", k)
    .child(avatar)
    .child(div().w(120).flex_none().min_w(0).truncate().text_size(T.text.sm).font_medium().text_color(done ? t.muted : t.foreground).child(it.kind === "report" ? "Daily report" : it.from))
    .child(div().id(`${k}-txt`).flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(done ? t.dim : t.muted).tooltip(it.text).child(text))
    .when(!hot, (e) => e.child(div().flex_none().max_w(140).truncate().text_size(T.text.xs).text_color(t.dim).child(pname)))
    .child(actions)
    .child(until ? relTime(t, `${k}-ts`, until, { text: whenLabel(until), color: INFO }).text_right() : relTime(t, `${k}-ts`, it.ts).w(40).text_right())
    .child(check);
  const replying = S.replyId === it.id && !done;
  const snoozing = S.snoozeId === it.id && !done;
  const expanded = S.openId === it.id;
  return v_flex().id(`${k}-w`).border_t_1().border_color(t.border)
    .child(main)
    .when(expanded, (el) => el.child(detail(t, it, k)))
    .when(snoozing, (el) => el.child(h_flex().h(36).pl(38).pr(12).pb(T.sp.sm).gap(6).items_center()
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("Snooze until"))
      .children(snoozeChoices().map((c, n) => h_flex().id(`${k}-sz-${c.k}`).flex_none().h(24).pl(T.sp.md).pr(T.sp.xs).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
        .border_1().border_color(t.border).text_size(T.text.xs).font_medium().text_color(t.foreground).hover((s) => s.bg(t.hover))
        .tooltip(`Back ${whenLabel(c.until)}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => setSnooze(cx, it, c.until))
        .child(c.label).child(kbd(t, String(n + 1)))))
      .child(div().flex_1())
      .child(iconButton(t, `${k}-szx`, "x", (_e, cx) => { S.snoozeId = null; cx.notify(); }, "Cancel (S)", { size: T.h.btnSm }))))
    .when(replying, (el) => el.child(h_flex().h(36).pl(38).pr(12).pb(T.sp.sm).gap(6).items_center()
      .when(S.reviseId === it.id, (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(WARN).child("What to change")))
      .child(h_flex().id(`${k}-in`).flex_1().h(T.h.input).px(T.sp.md).items_center().rounded(T.r.ctrl).border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(replyInput()).flex_1().h(26).text_size(T.text.sm).text_color(t.foreground)))
      .child(iconButton(t, `${k}-send`, "send", (_e, cx) => sendReply(cx), "Send (Enter)", { size: T.h.btn, color: t.accent }))
      .child(iconButton(t, `${k}-x`, "x", (_e, cx) => { S.replyId = null; cx.notify(); }, "Cancel (Esc)", { size: T.h.btn }))));
}

// Keyboard row (workspace.js navMark): j/k move, Enter opens (task panel, report text, or the reply field),
// → the sender's actions; A approve, X reject, R reply, E done / open, S snooze (then 1-4), Superhuman style.
function navItem(it) {
  const p = it.proj;
  const ref = it.kind === "task" ? { kind: "task", slug: it.slug, id: it.taskId }
    : it.kind === "report" ? null
    : p?.loose ? { kind: "loose", slug: it.slug, label: it.from } : it.from && it.from !== "ty" ? { kind: "agent", slug: it.slug, name: it.from } : null;
  const keys = {
    a: (cx) => approve(cx, it),
    x: (cx) => reject(cx, it),
    r: () => reply(it),
    e: (cx) => { if (!it.auto) setDone(cx, it, !isDone(it)); },
    s: (cx) => toggleSnoozeMenu(cx, it),
  };
  if (S.snoozeId === it.id) snoozeChoices().forEach((c, n) => { keys[String(n + 1)] = (cx) => setSnooze(cx, it, c.until); });
  return { key: `mb:${it.id}`, open: () => openItem(it), ref, keys };
}

export function mailboxView(ws, t, cx) {
  if ((!S.loading || now() - S.loading > 20000) && now() - S.at > 3000) refresh(cx);
  const openN = countOpen();
  const snoozedN = S.items.filter((x) => !isDone(x) && snoozedUntil(x)).length;
  const doneN = S.items.filter(isDone).length;
  const match = (x) => (S.filter === "open" ? isOpen(x) : S.filter === "snoozed" ? !isDone(x) && Boolean(snoozedUntil(x)) : isDone(x));
  const shown = S.items.filter(match).slice(0, S.filter === "done" ? 150 : 1000);
  const groups = GROUPS.map(([g, label, color]) => ({ g, label, color, items: shown.filter((it) => groupOf(it) === g) })).filter((x) => x.items.length);
  const chip = (k, label, n) => h_flex().id(`mp-mb-f-${k}`).h(22).px(T.sp.md).gap(6).rounded(T.r.chip).items_center().cursor_pointer().text_size(T.text.sm).font_medium()
    .bg(S.filter === k ? t.surface : clear).text_color(S.filter === k ? t.foreground : t.muted)
    .on_click((_e, cx) => { S.filter = k; S.replyId = null; S.snoozeId = null; cx.notify(); })
    .child(label).child(div().text_size(T.text.xs).text_color(t.dim).child(String(n)));
  const empty = { open: ["All clear. Nothing waits for you.", "Show done", "done"], snoozed: ["Nothing snoozed.", "Show open", "open"], done: ["Nothing done yet.", "Show open", "open"] }[S.filter];
  return v_flex().gap(12)
    .child(h_flex().gap(8).items_center().child(h_flex().p(2).gap(2).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
      .child(chip("open", "Open", openN)).child(chip("snoozed", "Snoozed", snoozedN)).child(chip("done", "Done", doneN)))
      .child(div().id("mp-mb-keys").flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim)
        .tooltip("j/k move · Enter open · A approve · X reject · R reply · E done · S snooze (1-4 picks the time)")
        .child("A approve · X reject · R reply · E done · S snooze"))
      .child(iconButton(t, "mp-mb-bell", notifyOn() ? "bell" : "bell-off", () => setNotify(!notifyOn()),
        notifyOn() ? "Notifications on: new questions, blocked agents and tasks. Click to mute." : "Notifications off. Click to turn on.",
        { size: T.h.btnSm, color: notifyOn() ? t.accent : t.dim })))
    .when(groups.length === 0 && !S.at, (el) => el.child(skeleton(t, 6)))
    .when(groups.length === 0 && Boolean(S.at), (el) => el.child(emptyLine(t, "mp-mb-empty", empty[0], [empty[1], () => { S.filter = empty[2]; }])))
    .children(groups.map(({ g, label, color, items }) => card(t, `mp-mb-g-${g}`).overflow_hidden()
      .child(h_flex().h(T.h.rowDense).px(12).gap(8).items_center()
        .child(div().flex_none().size(T.dot).rounded_full().bg(color ?? (g === "review" ? TASK_COLOR.review : t.dim)))
        .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(label))
        .child(div().flex_1().text_size(T.text.xs).text_color(t.dim).child(String(items.length))))
      .children(items.map((it, i) => ws.navMark(row(t, it, `${g}-${i}`), navItem(it))))));
}

// The full text of an item, readable: an epic plan as one line per task, an approval's command in mono.
function detail(t, it, k) {
  if (it.kind === "task") {
    return v_flex().pl(38).pr(T.pad.card).pb(T.sp.lg).gap(T.sp.sm)
      .child(div().text_size(T.text.sm).font_medium().text_color(t.foreground).whitespace_normal().child(`#${it.taskId} ${it.title ?? ""}`))
      .child(div().text_size(T.text.sm).line_height(`${T.lh.base}px`).whitespace_normal().text_color(t.foreground).child(it.reason || "No reason given."))
      .child(div().text_size(T.text.xs).text_color(t.dim).child(`${it.from} is waiting for this. Answer: your reply goes to ${it.from} with task #${it.taskId}, and it unblocks the task.`));
  }
  const text = String(it.text ?? "");
  const body = v_flex().pl(38).pr(T.pad.card).pb(T.sp.lg).gap(T.sp.sm);
  const para = (x) => div().text_size(T.text.sm).line_height(`${T.lh.base}px`).whitespace_normal().text_color(t.foreground).child(x);
  const plan = /^Approval #\d+: (Epic plan #\d+ .*?): (\d+ tasks?) - (.*)$/s.exec(text);
  if (plan) {
    const tasks = plan[3].split(/;\s*(?=#\d+)/).map((x) => x.trim()).filter(Boolean);
    return body.child(para(`${plan[1]} · ${plan[2]}`))
      .children(tasks.map((x, i) => h_flex().id(`${k}-pl-${i}`).gap(T.sp.sm).items_start()
        .child(div().flex_none().w(16).text_size(T.text.sm).text_color(t.dim).child(`${i + 1}.`))
        .child(div().flex_1().min_w(0).text_size(T.text.sm).line_height(`${T.lh.base}px`).whitespace_normal().text_color(t.foreground).child(x))))
      .child(div().text_size(T.text.xs).text_color(t.dim).child("Approve moves these tasks to To Do. Revise sends the plan back with your note."));
  }
  const cmd = /^(.*?) \| command: (.*)$/s.exec(text);
  if (cmd) {
    return body.child(para(cmd[1]))
      .child(div().px(T.sp.md).py(T.sp.sm).rounded(T.r.ctrl).bg(t.background).border_1().border_color(t.border)
        .text_size(T.text.xs).font_family("JetBrains Mono").whitespace_normal().text_color(t.foreground).child(cmd[2]))
      .child(div().text_size(T.text.xs).text_color(t.dim).child("Approve lets the agent run exactly this command once."));
  }
  return body.children(text.split(/\n+/).map((x) => para(x)));
}
