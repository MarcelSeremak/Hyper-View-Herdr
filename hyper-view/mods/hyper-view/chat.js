// Right panel: the selected project's agent conversation (from the hp event store).
// Tabs: Conversation (messages + task updates), Activity (everything), Commands (tool calls).
// Collapses to a 60 px rail of agent avatars; hidden altogether in modes without chat (toolbar.js MODES).
// On an agent page it is that agent's chat (filtered to it, messages go to it). Idle agents get nudged:
// direct/@mentioned ones, and for a team message only the lead.
import { T } from "./tokens.js";
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, hc, run, shared, setShared, exec, layout, settings } from "herdr";
import {
  currentSlug, startAgent, loadProject, loadEvents, watchData, liveAgent, agentAvatar, fmtTime, hp, toast, iconButton, icon, iconEl,
  openTab, showCenter, clear, OK, BAD, colorFor, tile,
measure, leadOf, mentionsOf, tourSizes, scrollY, listProjects, selectProject, view, } from "./lib.js";
import { RIGHT, LEFT, isCollapsed, togglePanel, chatHidden, rememberLayout } from "./toolbar.js";

// The agent whose page is open (project agents; a loose agent's chat is its own anyway), or null.
const agentCtxOf = () => { const v = view(); return v.kind === "project" && v.tab === "agent" && v.agent ? v.agent : null; };
import { taskPanel, openTaskPanel } from "./taskpanel.js";
import { relTime, kbd } from "./ide.js";

// Quick answers to a question addressed to you (buttons + keys while the message list has the keyboard,
// Mailbox-style): [key, label, color (null = muted), text sent].
// A question to Marcel = a question mark or "Odpowiedz ..." (AGENTS.md tells agents so); anything else is an
// FYI that stays in the chat. Keyword guessing ("zgoda", "potwierdź") caught plain status messages.
const ASK = /\?|\bodpowiedz\b|\breply\b/i;
const QUICK = [["a", "Approve", OK, "Approved. Go ahead."], ["r", "Reject", BAD, "Rejected. Do not do it; tell me the alternative."], ["w", "Wait", null, "Wait. I will get back to you."]];
// Focus handle of the message list (kept outside the instance: Herdr's in-place reload keeps instance fields only).
const KCM = new WeakMap();
const KC = (o) => { let s = KCM.get(o); if (!s) KCM.set(o, (s = {})); return s; };

const NUDGE_EVERY = 20000;
const GROUP_MS = 5 * 60 * 1000;
const SHOW = 400;
const FULL = "mp.chatFull"; // chat covers the main column, from the right edge to the sidebar
const READ_W = 820; // readable column width while full
const MAX_PX = 4000;
const ease = (x) => 1 - Math.pow(1 - x, 3);

// Ctrl+Enter sends too (the composer row declares "MpChat" while the @ popup is closed). Bound once per app;
// also from a task after a hot reload (which keeps instances without re-running init; illegal in render).
function bindSendKey(cx) {
  if (globalThis.__hvChatSendKeys) return;
  try {
    cx.bind_keys(["MpChat > Input", "MpChatAt > Input"].map((context) => ({ keystroke: "ctrl-enter", action: "mp_chat_send", context })));
    globalThis.__hvChatSendKeys = true;
  } catch (err) { console.warn("chat: send key", err); }
}

export class Chat {
  init(cx) {
    this.project = null;
    this.events = [];
    this.seen = null;
    this.tab = "chat"; // fixed: messages and task updates
    this.filter = null;
    this.pair = null;
    this.nudged = {};
    this.lastAt = 0;
    this.unread = 0;
    this.w = 380;
    this.hoverMsg = null;
    this.replyTo = null; // event being answered (task id carried along)
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Message the team… (@ to ask one agent)" });
    // Enter: completes the highlighted @name while the popup is open, otherwise sends.
    this.input.on("submit", (_e, cx) => {
      if (this.atOpen()) { this.completeAt(this.atMatches()[this.atIdx]?.name, cx); return; }
      if (Date.now() - (this.atDoneAt ?? 0) < 200) return; // the same Enter already completed a name
      this.send(cx);
    });
    // Draft text drives the @ autocomplete and the "who answers" hint under the composer.
    this.draft = "";
    this.atIdx = 0;
    this.atShut = null; // draft at which Esc closed the popup (it reopens once the draft changes)
    this.input.on("change", (_e, cx) => { const v = this.input.value(); if (v !== this.draft) this.atIdx = 0; this.draft = v; cx.notify(); });
    // @ popup keys. The Input's own bindings (context "Input") eat ↑ ↓ Enter Tab before any on_key_down,
    // so while the popup is open the composer row declares "MpChatAt" and these bindings — same depth as
    // the Input's, installed later — win. on_key_down on the row stays as a fallback.
    if (!globalThis.__hvChatAtKeys) try {
      const keys = [["up", "mp_at_up"], ["down", "mp_at_down"], ["tab", "mp_at_pick"], ["enter", "mp_at_pick"], ["escape", "mp_at_close"]];
      cx.bind_keys(keys.flatMap(([k, a]) => [{ keystroke: k, action: a, context: "MpChatAt > Input" }, { keystroke: k, action: a, context: "MpChatAt" }]));
      globalThis.__hvChatAtKeys = true; // the keymap is the app's: bind once per process, not per Chat
    } catch (err) { console.warn("chat: @ key bindings", err); }
    bindSendKey(cx);
    // "Chat with …" from the palette / list actions (actions.js chatWith): shared "mp.chatGo" = { name, text, at }.
    this.cgAt = shared("mp.chatGo")?.at;
    // Task detail panel (shared "mp.taskPanel"); only opens that happen after start expand the panel.
    this.tpProject = null;
    this.tpEvents = [];
    this.tpSeenAt = shared("mp.taskPanel")?.at;
    this.otSeen = shared("mp.openTask")?.at;
    try { KC(this).fh = cx.focus_handle(); } catch {}
    watchData(cx, (cx) => this.reload(cx), 15000, "chat"); // folder watch reloads at once; timer = fallback
    cx.spawn(async () => this.ensureRoom());
  }

  // ------------------------------------------------------------ message list keys
  // A / R / W answer the hovered (or keyboard-selected) question to you; ↑ ↓ move between questions,
  // Enter replies to it in the composer, Esc goes back to the composer.
  listKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || !KC(this).fh?.is_focused?.()) return;
    const list = this.visible();
    const asks = list.map((x, i) => (x.type === "message" && x.from !== "ty" && x.to === "ty" ? i : -1)).filter((i) => i >= 0);
    const cur = this.hoverMsg != null && asks.includes(this.hoverMsg) ? this.hoverMsg : asks.includes(this.selMsg) ? this.selMsg : null;
    const q = QUICK.find(([key]) => key === k);
    if (q && cur != null) { const ev = list[cur]; this.sendTo(cx, ev.from, q[3], ev.task); }
    else if ((k === "up" || k === "down") && asks.length) {
      const at = cur == null ? (k === "up" ? asks.length : -1) : asks.indexOf(cur);
      this.selMsg = asks[Math.max(0, Math.min(asks.length - 1, at + (k === "up" ? -1 : 1)))];
      this.hoverMsg = null;
      try { this.scroll.scroll_to_item(this.selMsg); } catch {}
    }
    else if (k === "enter" && cur != null) { this.replyTo = list[cur]; this.input.focus(); }
    else if (k === "escape") this.input.focus();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ------------------------------------------------------------ full width
  // Column width that reaches the sidebar: window - sidebar - 1 px divider - 10 px gap.
  fullPx() {
    // Window width (logical px) minus the sidebar as it really is (measured) minus divider + gap.
    const z = tourSizes();
    const vw = globalThis.window?.viewport_size?.()?.width ?? 0;
    const side = z.side?.w ?? (shared(LEFT.key) ? LEFT.rail : LEFT.open);
    // Layout sizes are in unzoomed px; the window is measured zoomed (Ctrl +/- zoom) — convert.
    let zoom = 1;
    try { zoom = Number(settings()?.zoom) || 1; } catch {}
    if (vw > 0) return Math.max(RIGHT.open, Math.floor((vw - side - 1) / zoom - 10));
    const center = z.center?.w ?? 0;
    return Math.round(this.curPx() + Math.max(0, center) + 10);
  }
  // Older running layouts cap the chat at 760 px: lift the cap (and the main column's min) once.
  ensureRoom() {
    if (this.roomOk) return null;
    this.roomOk = true;
    const tree = JSON.parse(JSON.stringify(layout() ?? null));
    let changed = false;
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.id === RIGHT.id && (n.max ?? 0) < MAX_PX) { n.max = MAX_PX; changed = true; }
      if (n.id === RIGHT.id && (n.min ?? 0) > 0) { n.min = 0; changed = true; } // hidden modes slide it to 0
      if (n.id === "mp-main-col" && n.min !== 0) { n.min = 0; changed = true; }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    if (!changed) return null;
    return exec("herdr-app", ["do", "layout.set", "--layout", JSON.stringify(tree)], { timeout: 20000 }).catch(() => run("layout.set", { layout: tree }));
  }
  slide(cx, from, to) {
    const steps = 10;
    this.sliding = true;
    this.px = to;
    for (let i = 1; i <= steps; i++) {
      cx.timer.after(i * 18, () => {
        run("layout.resize", { id: RIGHT.id, px: Math.round(from + (to - from) * ease(i / steps)) });
        if (i === steps) this.sliding = false;
      });
    }
  }
  curPx() { return Math.round((this.w ?? RIGHT.open - 20) + 20); }
  toggleFull(cx) {
    const on = !this.fullOn;
    this.fullOn = on;
    setShared(FULL, on);
    this.slide(cx, this.curPx(), on ? this.fullPx() : RIGHT.open);
  }
  collapse(cx) {
    rememberLayout("right", "rail");
    const start = this.fullOn ? this.curPx() : undefined;
    if (this.fullOn) { this.fullOn = false; setShared(FULL, false); }
    togglePanel(RIGHT, cx, start);
  }
  // Keeps the column in step with shared("mp.chatFull") set elsewhere, the window and the sidebar.
  syncFull(cx) {
    if (this.sliding || isCollapsed(RIGHT)) return;
    const want = Boolean(shared(FULL));
    let to = null;
    if (want !== Boolean(this.fullOn)) { this.fullOn = want; to = want ? this.fullPx() : RIGHT.open; }
    else if (want) { const px = this.fullPx(); if (Math.abs(px - (this.px ?? 0)) > 4) to = px; }
    if (to == null) return;
    this.px = to;
    cx.spawn(async () => { await this.ensureRoom(); run("layout.resize", { id: RIGHT.id, px: to }); });
  }

  // Mailbox: the chat takes the right half of the main area (questions on the left); elsewhere its usual width.
  syncMailbox(cx) {
    if (this.sliding || isCollapsed(RIGHT) || this.fullOn) return;
    const mb = view().kind === "mailbox";
    const want = mb ? Math.max(RIGHT.open, Math.round(this.fullPx() / 2)) : RIGHT.open;
    // Compared with the real width: after collapse + expand the column comes back at its normal width.
    const now = this.curPx();
    if (mb === this.mbWide && (!mb || Math.abs(want - (now ?? 0)) <= 8)) return;
    const was = this.mbWide;
    this.mbWide = mb;
    if (!mb && !was) return;
    this.px = want;
    cx.spawn(async () => { await this.ensureRoom(); run("layout.resize", { id: RIGHT.id, px: want }); });
  }
  // Which conversation (outside a project view): any project or loose agent; the choice is shared "mp.project".
  switcher(t) {
    const all = this.allList ?? [];
    const cur = this.project?.slug;
    const row = (x) => h_flex().id(`mp-chat-sw-${x.slug}`).h(T.h.row).px(T.sp.sm).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
      .bg(x.slug === cur ? t.selected : clear).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.switching = false; setShared("mp.project", x.slug); cx.notify(); })
      .child(x.loose ? agentAvatar(t, x.agents?.[0]?.name ?? x.name, liveAgent(x, x.agents?.[0]?.name), 18) : tile(x.name, { kind: "project", size: 18, color: x.color, radius: 4 }))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.foreground).child(x.loose ? x.agents?.[0]?.name ?? x.name : x.name))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(x.loose ? "agent" : `${(x.agents ?? []).length} agents`));
    const sec = (title) => div().px(T.sp.sm).pt(T.sp.md).pb(T.sp.xs).text_size(T.text.xs).font_medium().text_color(t.muted).child(title);
    const projs = all.filter((x) => !x.loose), loose = all.filter((x) => x.loose);
    return v_flex().w_full().px(T.sp.md).pt(T.sp.sm).gap(T.sp.xxs)
      .when(projs.length > 0, (el) => el.child(sec("Projects")).children(projs.map(row)))
      .when(loose.length > 0, (el) => el.child(sec("Agents")).children(loose.map(row)))
      .when(!all.length, (el) => el.child(div().px(T.sp.sm).text_size(T.text.sm).text_color(t.dim).child("No projects yet.")));
  }

  // Conversation filter: click an agent's name/avatar in a message (or a rail avatar); a removable
  // pill in the header shows it. Messages go to the team unless @one-agent or a reply.
  // The tutorial can pick a chat filter (shared "mp.chatPick" = { name, at }).
  pickFromTour() {
    const cp = shared("mp.chatPick");
    if (cp && cp.at !== this.pickAt) { this.pickAt = cp.at; this.pick(cp.name ?? null); }
  }
  pick(name) {
    this.filter = name ?? null;
    this.pair = null;
  }

  reload(cx) {
    return cx.spawn(async (cx) => {
      const slug = currentSlug();
      // Every project and loose agent: the switcher (header) outside project views, and the empty-state list.
      this.allList = await listProjects().catch(() => []);
      if (!slug) this.pickList = this.allList.filter((x) => !x.loose);
      const project = slug ? await loadProject(slug) : null;
      const events = await loadEvents(slug);
      const switched = project?.slug !== this.project?.slug;
      this.project = project;
      if (switched) { this.seen = events.length; this.pick(project?.loose ? null : agentCtxOf()); this.unread = 0; }
      else this.nudge(events);
      const grew = events.length - this.events.length;
      if (grew > 0 && !switched) { this.lastAt = Date.now(); if (isCollapsed(RIGHT)) this.unread += grew; }
      this.events = events;
      if (grew || switched) this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1));
      const tp = shared("mp.taskPanel");
      if (tp?.slug) {
        this.tpProject = tp.slug === project?.slug ? project : await loadProject(tp.slug);
        this.tpEvents = tp.slug === project?.slug ? events : await loadEvents(tp.slug);
      }
      cx.notify();
    });
  }

  nudge(events) {
    const p = this.project;
    if (!p || this.seen == null) { this.seen = events.length; return; }
    const fresh = events.slice(this.seen);
    this.seen = events.length;
    // Calm protocol: a team message wakes only the lead (when the human wrote and nobody is
    // @mentioned) and the @mentioned agents; the rest read it on their next hp inbox.
    const lead = leadOf(p);
    const who = new Map(); // name -> why
    for (const m of fresh) {
      if (m.type === "task") { if (m.to && m.to !== "all" && !who.has(m.to)) who.set(m.to, "direct"); continue; }
      if (m.type !== "message") continue;
      if (m.to && m.to !== "all") { who.set(m.to, "direct"); continue; }
      const ms = mentionsOf(p, m.text).filter((n) => n !== m.from);
      for (const n of ms) who.set(n, "mention");
      if (!ms.length && m.from === "ty" && lead && !who.has(lead)) who.set(lead, "lead");
    }
    const say = {
      direct: (n) => `You have new messages from the team. Check: hp inbox --as ${n}`,
      mention: (n) => `You were @mentioned in a team message. Check: hp inbox --as ${n}`,
      lead: (n) => `The human wrote to the whole team. You are the team lead: answer for the team. Check: hp inbox --as ${n}`,
    };
    for (const [name, why] of who) {
      const live = liveAgent(p, name);
      if (!live || (live.status !== "idle" && live.status !== "done")) continue;
      if (Date.now() - (this.nudged[name] ?? 0) < NUDGE_EVERY) continue;
      if (Date.now() - (globalThis.__hvNudged?.[`${p.slug}/${name}`] ?? 0) < NUDGE_EVERY) continue; // supervisor.js owner nudge just did it
      this.nudged[name] = Date.now();
      hc(["send", live.address, `${say[why](name)}\r`]).catch(() => {});
    }
  }

  // The human's last team message that the lead has not answered yet (last 30 min), or null.
  pendingTeam() {
    const p = this.project, lead = leadOf(p);
    if (!p || p.loose || !lead) return null;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type !== "message") continue;
      if (e.from === lead) return null;
      if (e.from === "ty" && (!e.to || e.to === "all")) {
        if (mentionsOf(p, e.text).length || Date.now() - new Date(e.ts) > 30 * 60 * 1000) return null;
        return e;
      }
    }
    return null;
  }

  // Who the draft goes to.
  target() {
    const p = this.project;
    if (!p) return "all";
    if (p.loose) return p.agents[0]?.name ?? "all";
    if (this.replyTo && this.replyTo.from !== "ty") return this.replyTo.from;
    const ms = mentionsOf(p, this.draft);
    if (ms.length === 1) return ms[0];
    // Agent page: its chat (while the conversation is filtered to it).
    const ctx = agentCtxOf();
    if (!ms.length && ctx && this.filter === ctx && !this.pair && p.agents.some((a) => a.name === ctx)) return ctx;
    return "all"; // several @: a team message they answer
  }
  // One quiet line under the composer: where the draft goes and who answers.
  teamHint(t) {
    const p = this.project, lead = leadOf(p);
    if (!p || p.loose) return null;
    const ms = mentionsOf(p, this.draft), to = this.target();
    let text;
    if (to !== "all") text = `→ ${to}`;
    else if (ms.length > 1) text = `→ team · ${ms.join(", ")} answer`;
    else if (!lead) text = "→ team";
    else {
      text = `→ team · ${lead} answers`;
      if (this.pendingTeam()) {
        const st = liveAgent(p, lead)?.status ?? "stopped";
        const a = p.agents.find((x) => x.name === lead);
        text = st === "working" ? `${lead} is working on it…`
          : st === "stopped" ? (a?.autorestart === false || p.status === "paused" ? `${lead} is stopped · start it to get an answer` : `starting ${lead}…`)
          : `waiting for ${lead}…`;
      }
    }
    return div().px(4).text_size(T.text.xs).text_color(t.dim).opacity(0.8).truncate().child(text);
  }

  // "@par" at the end of the draft (the caret after typing): matching agents, prefix matches first.
  atMatches() {
    const m = /(?:^|\s)@([\w-]*)$/.exec(this.draft ?? "");
    if (!m || !this.project || this.project.loose) return [];
    const q = m[1].toLowerCase();
    const all = this.project.agents;
    const pre = all.filter((a) => a.name.toLowerCase().startsWith(q));
    const mid = all.filter((a) => !pre.includes(a) && a.name.toLowerCase().includes(q));
    return [...pre, ...mid].slice(0, 6);
  }
  atOpen() { return this.atShut !== this.draft && this.atMatches().length > 0; }
  atMove(d, cx) {
    const n = this.atMatches().length;
    if (!n) return;
    this.atIdx = ((this.atIdx ?? 0) + d + n) % n;
    cx?.notify();
  }
  // Replaces the "@par" being typed with "@name " and leaves the caret after it.
  completeAt(name, cx) {
    if (!name) return;
    const v = this.input.value();
    const m = /@[\w-]*$/.exec(v);
    const start = m ? m.index : v.length;
    try {
      this.input.set_selected_range({ start, end: v.length });
      this.input.replace(`@${name} `);
    } catch { this.input.set_value(`${v.slice(0, start)}@${name} `); }
    const next = this.input.value();
    if (next !== `${v.slice(0, start)}@${name} `) this.input.set_value(`${v.slice(0, start)}@${name} `);
    const end = this.input.value().length;
    try { this.input.set_selected_range({ start: end, end }); } catch {}
    this.draft = this.input.value();
    this.atIdx = 0;
    this.atDoneAt = Date.now();
    this.input.focus();
    cx?.notify();
  }
  atKey(e, cx) {
    if (!this.atOpen()) return;
    const k = e.key;
    if (k === "up") this.atMove(-1, cx);
    else if (k === "down") this.atMove(1, cx);
    else if (k === "tab" || k === "enter") this.completeAt(this.atMatches()[this.atIdx]?.name, cx);
    else if (k === "escape") { this.atShut = this.draft; cx.notify(); }
    else return;
    cx.stop_propagation();
  }
  // Popup above the composer: avatar dot, name, role; the lead is marked.
  atPopup(t) {
    const p = this.project, lead = leadOf(p), list = this.atMatches();
    const idx = Math.min(this.atIdx ?? 0, list.length - 1);
    return v_flex().id("mp-chat-at").absolute().left(0).right(0).bottom(52).p(4).gap(1).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border).shadow_lg()
      .children(list.map((a, i) => h_flex().id(`mp-at-${a.name}`).h(28).px(8).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
        .bg(i === idx ? `${t.accent}26` : clear).hover((s) => s.bg(i === idx ? `${t.accent}26` : t.raised))
        .on_hover((h, cx) => { if (h && this.atIdx !== i) { this.atIdx = i; cx.notify(); } })
        .on_click((_e, cx) => this.completeAt(a.name, cx))
        .child(div().flex_none().size(10).rounded_full().bg(colorFor(`agent:${a.name}`)))
        .child(div().flex_none().text_size(T.text.sm).font_medium().text_color(i === idx ? t.foreground : t.muted).child(a.name))
        .when(a.name === lead, (el) => el.child(div().flex_none().px(4).rounded(T.r.chip).bg(`${t.accent}26`).text_size(T.text.xs).text_color(t.accent).child("lead")))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(a.role ?? ""))))
      .child(div().px(8).pt(4).pb(1).text_size(T.text.xs).text_color(t.dim).child("↑↓ choose · Tab/Enter complete · Esc close"));
  }

  visible() {
    let list = this.events;
    if (this.tab === "chat") list = list.filter((e) => e.type === "message" || e.type === "task");
    else if (this.tab === "commands") list = list.filter((e) => e.type === "tool");
    if (this.pair) { const [a, b] = this.pair; list = list.filter((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a)); }
    else if (this.filter) list = list.filter((e) => e.from === this.filter || e.to === this.filter);
    return list.slice(-SHOW);
  }

  send(cx) {
    const text = this.input.value().trim();
    if (!text || !this.project) return;
    this.draft = text;
    // Team by default; exactly one @agent or a reply: a direct message (several @: a team message they answer).
    const to = this.target();
    const task = this.replyTo && this.replyTo.from === to ? this.replyTo.task : null;
    this.input.set_value("");
    this.draft = "";
    this.atShut = null;
    cx.spawn(async (cx) => {
      this.replyTo = null;
      const p = this.project;
      const r = await hp(["say", text], { p: p.slug, as: "ty", to, task: task ? String(task) : undefined });
      // A loose agent starts on the first message: the message becomes its first prompt.
      if (r.ok && p.loose && p.agents[0] && !liveAgent(p, p.agents[0].name)) startAgent(p, p.agents[0], text);
      if (!r.ok) toast("Message not sent", r.err, "error");
      this.reload(cx);
    });
  }

  // Dense, bubble-less log (Linear comments / Zed agent panel): 20px avatar, "name · time · → to · #task" on
  // one line, consecutive messages from the same sender grouped under it; task and command events and
  // system notes are single dim lines aligned to the message text (no cards).
  item(t, e, i, prev) {
    const p = this.project;
    const TEXT_X = 16 + 20 + 8; // left edge of message text: px + avatar + gap
    if (e.type === "system") {
      return h_flex().id(`mp-c-${i}`).pl(TEXT_X).pr(16).py(4).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(e.text))
        .child(relTime(t, `mp-c-ts-${i}`, e.ts, { text: fmtTime(e.ts) }));
    }
    if (e.type === "task" || e.type === "tool") {
      const isTask = e.type === "task";
      const canOpen = isTask && Boolean(e.task);
      return h_flex().id(`mp-c-${i}`).pl(TEXT_X - 18).pr(16).py(4).gap(6).items_center().rounded(T.r.ctrl)
        .when(canOpen, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Open task")
          .on_click(() => openTaskPanel(p.slug, Number(e.task) || e.task)))
        .child(iconEl(isTask ? "check" : "terminal", isTask ? OK : t.dim, 12))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(isTask ? t.muted : t.dim).child(e.text))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(e.from))
        .child(relTime(t, `mp-c-ts-${i}`, e.ts, { text: fmtTime(e.ts) }));
    }
    const grouped = prev && prev.type === "message" && prev.from === e.from && prev.to === e.to && new Date(e.ts) - new Date(prev.ts) < GROUP_MS;
    const mine = e.from === "ty";
    const direct = e.to && e.to !== "all";
    const live = mine ? null : liveAgent(p, e.from);
    const hovered = this.hoverMsg === i;
    // Approve / Reject / Wait only under a question to you (same test as the Mailbox "Questions"); reports and
    // status messages to you are just read (hover: reply).
    // No Approve / Reject / Wait buttons in the chat: real approvals are in the Mailbox; questions get a reply.
    const askedMe = false && !mine && e.to === "ty" && ASK.test(String(e.text ?? ""));
    const listKb = Boolean(KC(this).fh?.is_focused?.());
    const kbSel = listKb && this.selMsg === i && this.hoverMsg == null;
    // Key hints (A R W) while the row is hovered or keyboard-selected.
    const hints = askedMe && (hovered || kbSel);
    const quick = (id, label, color, text, key) => h_flex().id(id).h(22).pl(8).pr(hints ? 4 : 8).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer()
      .border_1().border_color(t.border).text_color(color).text_size(T.text.xs).font_medium().hover((s) => s.bg(t.hover).border_color(t.input))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.sendTo(cx, e.from, text, e.task))
      .child(label).when(hints, (el) => el.child(kbd(t, key.toUpperCase())));
    return h_flex().id(`mp-c-${i}`).px(16).pt(grouped ? 2 : 10).gap(8).items_start().relative()
      .border_1().border_color(kbSel ? t.accent : clear)
      .when(hovered, (el) => el.bg(t.hover))
      .on_hover((h, cx) => {
        const n = h ? i : this.hoverMsg === i ? null : this.hoverMsg;
        if (n !== this.hoverMsg) {
          this.hoverMsg = n;
          // A question to you under the mouse takes the keyboard (A / R / W) unless a draft is being written.
          if (h && askedMe && !String(this.draft ?? "").trim()) { try { KC(this).fh?.focus(); globalThis.__hvZone = "chat"; } catch {} }
          cx.notify();
        }
      })
      .when(askedMe, (el) => el.on_mouse_down("left", (_e, cx) => { this.selMsg = i; try { KC(this).fh?.focus(); } catch {} cx.notify(); }))
      .child(grouped ? div().w(20).flex_none() : mine
        ? h_flex().flex_none().size(20).rounded_full().bg(t.accent).items_center().justify_center().text_size(T.text.xs).font_semibold().text_color(t.accent_foreground).child("Y")
        : div().id(`mp-c-av-${i}`).flex_none().cursor_pointer().tooltip(`Show only ${e.from}`).on_click((_e, cx) => this.filterTo(e.from, cx)).child(agentAvatar(t, e.from, live, 20)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .when(!grouped, (el) => el.child(h_flex().h(20).gap(6).items_center()
          .child(mine ? div().text_size(T.text.xs).font_semibold().child("You")
            : div().id(`mp-c-who-${i}`).text_size(T.text.xs).font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent))
              .tooltip(`Show only ${e.from}`).on_click((_e, cx) => this.filterTo(e.from, cx)).child(e.from))
          .when(direct, (el) => el.child(div().id(`mp-c-pair-${i}`).cursor_pointer().text_size(T.text.xs).text_color(t.dim)
            .hover((s) => s.text_color(t.accent))
            .on_click((_e, cx) => { this.pair = [e.from, e.to]; this.filter = null; this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1)); cx.notify(); })
            .tooltip("Show only this conversation")
            .child(`→ ${e.to === "ty" ? "you" : e.to}`)))
          .when(Boolean(e.task), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(`#${e.task}`)))
          .child(relTime(t, `mp-c-ts-${i}`, e.ts, { text: fmtTime(e.ts) }))))
        .child(div().text_size(T.text.xs).line_height(`${T.lh.sm}px`).whitespace_normal().text_color(t.foreground).child(e.text))
        // A question to you: answer with one click.
        .when(askedMe, (el) => el.child(h_flex().pt(4).pb(2).gap(6)
          .children(QUICK.map(([key, label, color, text]) => quick(`mp-c-q${key}-${i}`, label, color ?? t.muted, text, key))))))
      // Hover: reply straight to the sender (icon button, top right of the row).
      .when(hovered && !mine, (el) => el.child(h_flex().absolute().top(grouped ? 0 : 8).right(12).child(
        iconButton(t, `mp-c-reply-${i}`, "send", (_e, cx) => { this.replyTo = e; this.input.focus(); cx.notify(); }, `Reply to ${e.from}`, { size: 22, filled: true }))));
  }

  filterTo(name, cx) {
    this.pick(this.filter === name && !this.pair ? null : name);
    this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1));
    cx.notify();
  }

  sendTo(cx, to, text, task) {
    if (!this.project) return;
    cx.spawn(async (cx) => {
      const r = await hp(["say", text], { p: this.project.slug, as: "ty", to, task: task ? String(task) : undefined });
      if (!r.ok) toast("Message not sent", r.err, "error");
      this.reload(cx);
    });
  }

  // No project open: a compact list of projects to open (each one's chat appears once it is open).
  picker(t) {
    const list = this.pickList ?? [];
    const open = (x) => { selectProject(x.slug, "overview"); showCenter("mp-view"); };
    return v_flex().w_full().px(T.sp.md).pt(T.sp.lg).gap(T.sp.xxs)
      .child(div().px(T.sp.sm).pb(T.sp.sm).text_size(T.text.xs).text_color(t.dim).whitespace_normal().child("Open a project to chat with its team."))
      .children(list.map((x) => h_flex().id(`mp-chat-pick-${x.slug}`).h(T.h.rowDense).px(T.sp.sm).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => open(x))
        .child(tile(x.name, { kind: "project", size: 16, color: x.color, radius: 4 }))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.foreground).child(x.name))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`${(x.agents ?? []).length} agents`))));
  }

  rail(t) {
    const p = this.project;
    // Without a project the rail lists the projects (click opens one; the panel then expands again).
    const projects = p ? [] : (this.pickList ?? []);
    return v_flex().id("mp-chat").size_full().items_center().gap(8).py(12).bg(t.surface).rounded(T.r.dialog).border_1().border_color(t.border)
      .child(iconButton(t, "mp-chat-expand", "chevron-left", (_e, cx) => { this.unread = 0; rememberLayout("right", "open"); togglePanel(RIGHT, cx); }, p ? "Expand conversation" : "Expand panel", { size: 32 }))
      .child(div().relative().child(h_flex().size(28).rounded(T.r.panel).bg(t.raised).items_center().justify_center().child(iconEl("messages", t.accent, 14)))
        .when(this.unread > 0, (el) => el.child(h_flex().absolute().right(-6).top(-6).h(16).min_w(16).px(4).rounded(T.r.panel).bg(t.accent).items_center().justify_center()
          .text_size(T.text.micro).font_semibold().text_color(t.accent_foreground).child(String(Math.min(99, this.unread))))))
      .child(div().w(24).h(1).bg(t.border))
      .children((p?.agents ?? []).map((a) => div().id(`mp-cr-${a.name}`).cursor_pointer().tooltip(a.name)
        .on_click((_e, cx) => { if (!p.loose) this.pick(a.name); this.unread = 0; rememberLayout("right", "open"); togglePanel(RIGHT, cx); })
        .child(agentAvatar(t, a.name, liveAgent(p, a.name), 24))))
      .children(projects.map((x) => div().id(`mp-cr-p-${x.slug}`).cursor_pointer().tooltip(`Open ${x.name}`)
        .on_click(() => { selectProject(x.slug, "overview"); showCenter("mp-view"); })
        .child(tile(x.name, { kind: "project", size: 24, color: x.color, radius: 6 }))));
  }

  render(cx) {
    this.pickFromTour();
    // Keyboard zone "chat" (F6 / "c" in the view, shortcuts.js): the task panel's composer when it is open, else the chat's.
    const fz = shared("mp.focus");
    if (fz?.to === "chat" && fz.at !== this.fzAt && Date.now() - fz.at < 3000) {
      this.fzAt = fz.at;
      globalThis.__hvZone = "chat";
      // A timer task, not cx.spawn: focus() throws during render and a spawn body starts synchronously.
      cx.timer.after(1, (cx) => {
        if (isCollapsed(RIGHT)) { run("layout.resize", { id: RIGHT.id, px: RIGHT.open }); setShared(RIGHT.key, false); }
        try { (shared("mp.taskPanel") && this.tpInput ? this.tpInput : this.input).focus(); } catch {}
        cx.notify();
      });
    }
    const t = theme();
    const p = this.project;
    const slug = currentSlug();
    if (slug && slug !== p?.slug && this.wanted !== slug) { this.wanted = slug; this.reload(cx); }
    if (!slug && this.wanted !== null) { this.wanted = null; this.reload(cx); }
    // Agent page: the conversation follows the agent (a filter pill; × shows the whole team again).
    const ctx = p?.loose ? null : agentCtxOf();
    if (ctx !== this.agentCtx) {
      this.agentCtx = ctx;
      if (p && (!ctx || p.agents.some((a) => a.name === ctx))) { this.pick(ctx); this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1)); }
    }
    // Older code opens tasks with mp.openTask: show them in this panel.
    const ot = shared("mp.openTask");
    if (ot && ot.at !== this.otSeen) { this.otSeen = ot.at; cx.spawn(async () => openTaskPanel(ot.slug, ot.id)); }
    const tp = shared("mp.taskPanel");
    if (tp && tp.at !== this.tpSeenAt) {
      this.tpSeenAt = tp.at; this.tpMenu = null; this.tpConfirm = null; this.descEdit = null; this.tpAll = null;
      if (isCollapsed(RIGHT)) cx.spawn(async () => { run("layout.resize", { id: RIGHT.id, px: RIGHT.open }); setShared(RIGHT.key, false); });
    }
    const dm = shared("mp.devTpMenu"); // design previews only: open a task panel dropdown
    if (tp && dm && dm.at !== this.dmAt) { this.dmAt = dm.at; this.tpMenu = `${tp.slug}/${tp.id}:${dm.k}`; }
    const dd = shared("mp.devChatDraft"); // design previews only: put a draft in the composer ({ text, at })
    if (dd && dd.at !== this.ddAt) { this.ddAt = dd.at; cx.timer.after(1, (cx) => { this.input.set_value(dd.text ?? ""); this.draft = this.input.value(); this.atIdx = dd.idx ?? 0; try { this.input.focus(); } catch {} cx.notify(); }); }
    if (!KC(this).fh && !KC(this).asked) { KC(this).asked = true; cx.timer.after(1, (cx) => { try { KC(this).fh = cx.focus_handle(); } catch {} cx.notify(); }); }
    if (!globalThis.__hvChatSendKeys && !globalThis.__hvChatSendAsked) { globalThis.__hvChatSendAsked = true; cx.spawn(async (cx) => { bindSendKey(cx); cx.notify(); }); }
    const cg = shared("mp.chatGo");
    if (cg && cg.at !== this.cgAt) {
      this.cgAt = cg.at;
      this.pick(cg.name ?? null);
      cx.spawn(async (cx) => {
        if (shared("mp.taskPanel")) setShared("mp.taskPanel", null);
        if (isCollapsed(RIGHT)) { run("layout.resize", { id: RIGHT.id, px: RIGHT.open }); setShared(RIGHT.key, false); }
        this.input.set_value(cg.text ?? ""); this.draft = this.input.value(); this.atShut = this.draft;
        this.input.focus();
        cx.notify();
      });
    }
    if (tp?.slug && this.tpProject?.slug !== tp.slug && this.tpWanted !== tp.slug) { this.tpWanted = tp.slug; this.reload(cx); }
    // Hidden column (or sliding away / in): an empty panel; the mode decides (toolbar.js setChat).
    if (chatHidden()) return div().id("mp-chat").size_full().bg(t.surface).rounded(T.r.dialog).border_1().border_color(t.border);
    this.syncFull(cx);
    this.syncMailbox(cx);
    if (isCollapsed(RIGHT)) return this.rail(t);
    if (tp?.slug) return taskPanel(this, t, tp);
    const full = Boolean(this.fullOn);
    const read = (el) => (full ? el.w_full().max_w(READ_W) : el);
    const list = this.visible();
    const live = Date.now() - this.lastAt < 60000 || (p && p.agents.some((a) => liveAgent(p, a.name)?.status === "working"));
    const at = Boolean(p) && this.atOpen();
    // Header pill for the conversation filter (agent or a pair); × shows everything again.
    const fLabel = this.pair ? `${this.pair[0]} ⇄ ${this.pair[1] === "ty" ? "you" : this.pair[1]}` : this.filter ? (this.filter === "ty" ? "you" : this.filter) : null;
    const pill = () => h_flex().id("mp-chat-filter").flex_none().h(22).pl(8).pr(4).gap(4).rounded(T.r.ctrl).items_center().cursor_pointer()
      .bg(`${t.accent}1f`).text_size(T.text.xs).text_color(t.accent).hover((s) => s.bg(`${t.accent}33`)).tooltip("Show everyone")
      .on_click((_e, cx) => { this.pick(null); this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1)); cx.notify(); })
      .when(Boolean(this.filter) && !this.pair, (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(colorFor(`agent:${this.filter}`))))
      .child(div().max_w(160).truncate().child(fLabel)).child(iconEl("x", t.accent, 11));
    const tab = (k, label) => v_flex().id(`mp-ct-${k}`).flex_none().cursor_pointer().on_click((_e, cx) => { this.tab = k; this.scroll.scroll_to_item(Math.max(0, this.visible().length - 1)); cx.notify(); })
      .child(div().h(40).px(2).pt(13).text_size(T.text.sm).font_medium().text_color(this.tab === k ? t.foreground : t.muted).child(label))
      .child(div().h(2).rounded_full().bg(this.tab === k ? t.accent : clear));

    return v_flex().id("mp-chat").size_full().bg(t.surface).rounded(T.r.dialog).border_1().border_color(t.border).overflow_hidden().text_color(t.foreground)
      .on_size_change((size, cx) => { measure("chat")(size); if (Math.abs((this.w ?? 0) - size.width) > 6) { this.w = size.width; cx.notify(); } })
      // A click anywhere in the panel makes "chat" the last keyboard zone (an overlay closing gives it back).
      .on_mouse_down("left", () => { globalThis.__hvZone = "chat"; })
      // One simple header: collapse, full width, "Chat", the project.
      .child(h_flex().flex_none().px(12).pt(12).pb(12).gap(8).items_center().border_b_1().border_color(t.border)
        .child(iconButton(t, "mp-chat-collapse", "chevron-right", (_e, cx) => this.collapse(cx), "Collapse panel"))
        .child(iconButton(t, "mp-chat-full", full ? "minimize" : "maximize", (_e, cx) => this.toggleFull(cx), full ? "Restore width" : "Expand to full width", { color: full ? t.accent : undefined }))
        .child(div().text_size(T.text.sm).font_semibold().child("Chat"))
        // Outside a project view the conversation can be switched (any project or loose agent).
        .when(view().kind !== "project", (el) => el.child(h_flex().id("mp-chat-switch").flex_1().min_w(0).gap(4).items_center().cursor_pointer()
          .tooltip("Switch conversation").on_click((_e, cx) => { this.switching = !this.switching; cx.notify(); })
          .child(div().min_w(0).truncate().text_size(T.text.sm).text_color(this.switching ? t.accent : t.dim)
            .child(p ? `· ${p.loose ? p.agents[0]?.name ?? p.name : p.name}` : "· pick a conversation"))
          .child(iconEl(this.switching ? "chevron-up" : "chevron-down", this.switching ? t.accent : t.dim, 12))))
        .when(view().kind === "project" && Boolean(p), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.dim).child(`· ${p.loose ? p.agents[0]?.name ?? p.name : p.name}`)))
        .when(Boolean(p) && Boolean(fLabel), (el) => el.child(pill())))
      .child(scrollY("mp-chat-scroll", v_flex().id("mp-chat-list").flex_1().min_h(0).track_scroll(this.scroll).pb(12).when(full, (el) => el.items_center())
        .when(Boolean(KC(this).fh), (el) => el.track_focus(KC(this).fh)).key_context("HvChatList").on_key_down((e, cx) => this.listKey(e, cx))
        .when(list.length === 0 && Boolean(p), (el) => el.child(div().w_full().px(T.pad.card).py(T.pad.card).text_size(T.text.sm).text_color(t.dim).whitespace_normal()
          .child("No messages yet. Write below to brief the team, or @name to ask one agent.")))
        .when(!p && view().kind === "project", (el) => el.child(this.picker(t)))
        .when((this.switching || !p) && view().kind !== "project", (el) => el.child(this.switcher(t)))
        .when(!(this.switching && view().kind !== "project"), (el) => el.children(list.map((e, i) => read(this.item(t, e, i, list[i - 1])))))))
      .when(Boolean(p), (el) => el.child(h_flex().flex_none().px(12).pb(12).pt(12).justify_center().border_t_1().border_color(t.border).child(read(v_flex().flex_1().min_w(0).gap(8))
        .when(Boolean(this.replyTo), (el) => el.child(h_flex().h(28).pl(8).pr(4).gap(8).items_center().border_l_2().border_color(t.accent)
          .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(`Replying to ${this.replyTo.from}: ${this.replyTo.text}`))
          .child(iconButton(t, "mp-reply-x", "x", (_e, cx) => { this.replyTo = null; cx.notify(); }, "Cancel reply", { size: 20 }))))
        // Composer; "@par" opens the agent popup above it (keys: see init).
        .child(div().relative().w_full()
          .when(at, (el) => el.child(this.atPopup(t)))
          .child(h_flex().id("mp-chat-composer").h(36).pl(12).pr(4).gap(8).items_center().rounded(T.r.panel).border_1().border_color(at ? t.accent : t.input).bg(t.background)
            .key_context(at ? "MpChatAt" : "MpChat")
            .when(Boolean(globalThis.__hvChatSendKeys), (el) => el.on_action("mp_chat_send", (_e, cx) => this.send(cx)))
            .when(at, (el) => el
              .on_action("mp_at_up", (_e, cx) => this.atMove(-1, cx))
              .on_action("mp_at_down", (_e, cx) => this.atMove(1, cx))
              .on_action("mp_at_pick", (_e, cx) => this.completeAt(this.atMatches()[this.atIdx]?.name, cx))
              .on_action("mp_at_close", (_e, cx) => { this.atShut = this.draft; cx.notify(); })
              .on_key_down((e, cx) => this.atKey(e, cx)))
            .child(Input.new(this.input).flex_1().h(28).text_size(T.text.xs).text_color(t.foreground))
            .child(h_flex().id("mp-chat-send").flex_none().size(24).rounded(T.r.ctrl).bg(t.accent).tooltip("Send (Enter)").items_center().justify_center().cursor_pointer()
              .hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.send(cx))
              .child(svg(icon("send")).size(T.icon.row).text_color(t.accent_foreground)))))
        .when(Boolean(this.teamHint(t)), (el) => el.child(this.teamHint(t))))));
  }
}
