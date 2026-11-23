// Center of the app: project workspace (Overview, Agents, Tasks, Epics, Machines, Activity, Settings),
// the machine view, Tokens & Access and global Settings. shared("mp.view") decides which.
import { cardHead as cardHeader, emptyLine, skeleton, relTime, relShort, kbd, section } from "./ide.js";
import { T } from "./tokens.js";
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, run, hc, shared, setShared } from "herdr";
import { DEMO_USAGE } from "./demo.js";
import {
  view, openTab, openVm, showCenter, loadProject, loadEvents, loadMachines, loadSecrets, loadSecretUses, listProjects, watchData, claimJob, repeat,
  demo, fmtTok, usageTotal, liveAgent, currentTask, nextTask, startAgent, projectSpace, selectProject, openSsh, hp, toast, vmStats, vmHealth, icon,
  agentAvatar, tile, grid, gridCols, iconEl, iconButton, button, meter, pill, card, empty, tabsBar,
  STATUS_EN, TASK_EN, TASK_COLOR, PRIO, OK, WARN, BAD, INFO, statusColor, colorFor, fmtTime, fmtDate, ago, pct, clear,
  splitRow, sideCol, openMailbox, measure, scrollY, popFocus, restoreFocus, leadOf,
} from "./lib.js";
import { spark, buckets } from "./charts.js";
import { openForm, accessEditor, accessArgs, switchEl, RISKS, riskOf, riskSeg } from "./form.js";
import { vmView, machinesOverview } from "./vmview.js";
import { secretsView, settingsView } from "./secrets.js";
import { clipboardView, loadClips, changeClips } from "./clipboard.js";
import { skillsView, mcpView, kitPanels, listPanel, searchField, loadSkills, loadMcp, changeSkills, changeMcp } from "./kit.js";
import { typeOf, typeLabel } from "./secretkinds.js";
import { mailboxView, ASK as MAIL_ASK } from "./mailbox.js";
import { dashboardView, dashKey } from "./dashboard.js";
import { mapView, mapKey } from "./mapview.js";
import { startActivity, actCurrent, actItems, actUsage, actHasData, actTokens } from "./activity.js";
import { usageCard as actUsageCard, KIND } from "./activityview.js";
import { markManualStop } from "./supervisor.js";
import { openTaskPanel, taskPanelOpen, closeTaskPanel, isEpic, epicKids, epicPlanLabel } from "./taskpanel.js";
import { openActions } from "./actions.js";
import { agentsTab, agentsSummary, agentFacts } from "./agentsview.js";
import { openAgentPage, tabsOf } from "./toolbar.js";
import { activitySection, activityView, pinnedStale, projectRuns, runList, openProjectActivity, computeQueuedRuns } from "./projectactivity.js";
import { startDailyReport } from "./dailyreport.js";
import { VirtualListScrollHandle, Popover } from "gpui-base";

const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const COL_SHOW = 6;   // board: cards per column before "+N more"
// Greedy word wrap to `cpl` characters per line; more than two lines: the second ends with "…".
function clamp2(text, cpl) {
  const s = String(text ?? ""); cpl = Math.max(8, cpl | 0);
  if (s.length <= cpl) return s;
  const lines = [""];
  for (const w of s.split(/\s+/)) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if (cur.length + 1 + w.length <= cpl) lines[lines.length - 1] = `${cur} ${w}`;
    else lines.push(w);
  }
  if (lines.length <= 2 && lines.every((l) => l.length <= cpl)) return s;
  let second = lines.slice(1).join(" ");
  if (lines[0].length > cpl) { second = lines[0].slice(cpl) + " " + second; lines[0] = lines[0].slice(0, cpl); }
  return `${lines[0]} ${second.slice(0, cpl - 1).trimEnd()}…`;
}

// Keyboard state lives outside the instance (focus handles and row closures can't be carried over by
// Herdr's in-place reload, which keeps instance fields): one entry per copy, rebuilt lazily.
const KBS = new WeakMap();
const K = (o) => { let s = KBS.get(o); if (!s) KBS.set(o, (s = {})); return s; };

// Views with their own search field (Ctrl+F / "/" focus it; elsewhere the sidebar search).
export const hasViewSearch = (v) => v.kind === "project" && v.tab === "tasks";

export class Workspace {
  init(cx) {
    this.taskSearchState(); // input state must be created outside render
    this.secSearchState();
    // Activity runs are built outside render (projectactivity.js): one queued rebuild per tick, then redraw.
    repeat(cx, 400, (cx) => { if (computeQueuedRuns()) cx.notify(); }, claimJob("view.runs"));
    for (const k of ["acc", "cred", "skills", "servers", "pcred"]) this.agQ(k); // panel searches (agent page, project Credentials)
    this.project = null;
    this.events = [];
    this.machines = [];
    this.secrets = [];
    this.uses = [];
    this.projects = [];
    this.taskMode = "kanban";
    this.taskFilter = null;
    this.activityType = "all";
    this.limit = 200;
    this.confirm = null;
    this.vmSel = null;
    this.width = 1000;
    this.usage = {};
    // Keyboard: one focus handle for the whole center view (made here: cx.focus_handle() throws in render).
    // Lists register their rows while rendering (navMark); j/k ↑/↓ move, Enter opens, → shows the row's actions.
    K(this).fh = cx.focus_handle();
    K(this).nav = [];
    K(this).navSel = {};
    this.focusAt = shared("mp.focus")?.at;
    watchData(cx, (cx) => this.reload(cx), 30000, "view"); // folder watch reloads at once; timer = fallback
    startActivity(cx, () => this.projects); // session-log timeline + tokens per day (activity.js)
    repeat(cx, 5 * 60 * 1000, (cx) => this.loadUsage(cx, true), claimJob("view.usage"));
    // Project Activity (full view): the list's scroll handle and the pinned day header (re-render when the
    // top row moved into another day); the daily Mailbox report (dailyreport.js, once per day).
    this.agentPickState();
    try { this.paScroll = VirtualListScrollHandle.new(); } catch {}
    repeat(cx, 1000, (cx) => { const v = view(); if (v.kind === "project" && v.tab === "activity" && pinnedStale()) cx.notify(); }, claimJob("view.pinned"));
    startDailyReport(cx);
  }
  // Rows of a keyboard list that draws its own highlight (virtual lists allow no handlers per row).
  navPush(item) { (K(this).nav ??= []).push(item); }
  navSelKey() { return (K(this).navSel ?? {})[this.navView]; }
  navSelSet(key) { (K(this).navSel ??= {})[this.navView] = key; }
  // Tasks: the agent dropdown's search field (when the project has more than 6 agents).
  agentPickState() {
    if (!this.agentPick) {
      this.agentPick = InputState.new({ placeholder: "Filter agents" });
      this.agentPick.on("change", (_e, cx) => { this.agentPickQ = this.agentPick.value().trim().toLowerCase(); cx.notify(); });
    }
    return this.agentPick;
  }

  reload(cx) {
    return cx.spawn(async (cx) => {
      const v = view();
      this.machines = await loadMachines();
      this.projects = await listProjects();
      if (v.kind === "project") {
        const p = await loadProject(v.slug);
        if (p?.slug !== this.project?.slug) { this.taskFilter = null; this.vmSel = null; }
        this.project = p;
        this.events = await loadEvents(v.slug);
        this.loadUsage(cx, false);
      }
      this.secrets = await loadSecrets(); // also the agent page / project Credentials panels
      if (v.kind !== "project") this.uses = await loadSecretUses();
      if (v.kind === "clipboard") this.clips = (await loadClips()).items;
      // Skills / MCP servers: their own views and every agent page (small files).
      this.skills = (await loadSkills()).items;
      this.mcp = (await loadMcp()).items;
      this.loadedKey = this.key(v);
      cx.notify();
    });
  }
  // Tokens per agent (hp usage reads Claude Code / Codex session logs). Refreshed every 5 min.
  loadUsage(cx, force) {
    const slug = this.project?.slug;
    if (!slug || demo()) return;
    if (!force && this.usage[slug]) return;
    if (actHasData(slug)) return; // activity.js reads the same logs incrementally
    this.usage[slug] ??= { agents: {} };
    cx.spawn(async (cx) => {
      const r = await hp(["usage"], { p: slug }, 120000);
      try { if (r.ok) { this.usage[slug] = JSON.parse(r.out); cx.notify(); } } catch {}
    });
  }
  agentUsage(p, name) {
    if (demo()) return DEMO_USAGE[name] ?? null;
    const act = actUsage(p.slug, name);
    if (act) return act;
    return this.usage[p.slug]?.agents?.[name] ?? null;
  }

  key(v) { return v.kind === "project" ? `p:${v.slug}` : v.kind === "vm" ? `v:${v.name}` : v.kind; }

  act(cx, positional, options, ok) {
    cx.spawn(async (cx) => {
      const r = await hp(positional, options);
      if (!r.ok) toast("Something went wrong", r.err, "error");
      else if (ok) toast(ok, "", "success");
      setShared("mp.reloadAt", Date.now()); // sidebar, header, status too
    });
  }
  confirmButton(t, id, label, onConfirm, opts = {}) {
    if (this.confirm === id) return button(t, `${id}-sure`, "Are you sure?", (e, cx) => { this.confirm = null; onConfirm(e, cx); }, { ...opts, danger: true });
    return button(t, id, label, (_e, cx) => {
      this.confirm = id; cx.notify();
      cx.timer.after(3000, (cx) => { if (this.confirm === id) { this.confirm = null; cx.notify(); } });
    }, opts);
  }
  clipChange(cx, fn) {
    cx.spawn(async (cx) => {
      if (!(await changeClips(fn))) toast("Could not save", "The clipboard file changed; try again.", "error");
      this.clips = (await loadClips()).items;
      cx.notify();
    });
  }
  // Skills / MCP servers (kit.js): key "skills" | "servers".
  kitChange(cx, key, fn) {
    cx.spawn(async (cx) => {
      if (!(await (key === "skills" ? changeSkills : changeMcp)(fn))) toast("Could not save", "The file changed; try again.", "error");
      this.skills = (await loadSkills()).items;
      this.mcp = (await loadMcp()).items;
      cx.notify();
    });
  }
  metaRow(t, label, value, color) {
    return h_flex().gap(8).py(4).child(div().w(110).flex_none().text_size(T.text.sm).text_color(t.muted).child(label))
      .child(div().flex_1().min_w(0).text_size(T.text.sm).text_color(color ?? t.foreground).truncate().child(value));
  }

  render(cx) {
    const t = theme();
    const v = view();
    if (this.key(v) !== this.loadedKey && this.wanted !== this.key(v)) { this.wanted = this.key(v); this.reload(cx); }
    const dm = shared("mp.devTaskMode"); // design previews only
    if (dm && dm.at !== this.dmAt) { this.dmAt = dm.at; this.taskMode = dm.mode; }
    // Agent pages are views ({ kind: "project", slug, tab: "agent", agent }); old "mp.openAgent" jumps are
    // turned into them by the sidebar (sidebar.js syncMode).
    const tabKey = `${v.kind}:${v.slug ?? v.name ?? ""}:${v.tab ?? ""}:${v.agent ?? ""}`;
    // Hot reload keeps old instances without re-running init: make the keyboard state lazily.
    K(this).navSel ??= {};
    if (!K(this).fh && !K(this).fhAsked) { K(this).fhAsked = true; cx.spawn(async (cx) => { try { K(this).fh = cx.focus_handle(); } catch {} cx.notify(); }); }
    const fr = shared("mp.focus");
    if (K(this).fh && fr && fr.at !== this.focusAt) {
      this.focusAt = fr.at;
      if (fr.to === "view" && Date.now() - fr.at < 3000) { globalThis.__hvZone = "view"; this.autoPick = true; cx.timer.after(1, (cx) => { try { K(this).fh.focus(); } catch {} cx.notify(); }); }
      else if (fr.to === "find" && hasViewSearch(v)) cx.timer.after(1, () => { try { this.taskSearchState().focus(); } catch {} });
    }
    K(this).nav = [];
    this.navKeys = null; this.navEsc = null; // list-level keys / Esc of the view being drawn (agents table, activity)
    this.navView = `${tabKey}:${this.taskMode}`;
    let body;
    if (v.kind === "vm") body = vmView(this, t, v);
    else if (v.kind === "machines") body = machinesOverview(this, t, cx);
    else if (v.kind === "secrets") body = secretsView(this, t);
    else if (v.kind === "settings") body = settingsView(this, t);
    else if (v.kind === "clipboard") body = clipboardView(this, t, openForm);
    else if (v.kind === "skills") body = skillsView(this, t, openForm);
    else if (v.kind === "mcp") body = mcpView(this, t, openForm);
    else if (v.kind === "mailbox") body = mailboxView(this, t, cx);
    else if (v.kind === "dashboard") body = dashboardView(this, t, cx);
    else if (v.kind === "map") body = mapView(this, t, cx);
    else body = this.projectView(t, v);
    // Focus requests run from a timer task: FocusHandle.focus() throws during render, and a cx.spawn body
    // runs synchronously up to its first await (so a spawn from render is still "during render").
    // Keyboard landed here (F6, Enter in the explorer): highlight the first row so ↑↓ start somewhere visible.
    if (K(this).fh) (globalThis.__hvFH ??= {}).view = K(this).fh;
    if (this.autoPick) { this.autoPick = false; const nav = K(this).nav ?? []; if (nav.length && !nav.some((x) => x.key === K(this).navSel[this.navView]) && v.kind !== "dashboard") { K(this).navSel[this.navView] = nav[0].key; cx.notify(); } }
    return v_flex().id("mp-view").size_full().bg(t.canvas).text_color(t.foreground)
      .when(Boolean(K(this).fh), (el) => el.track_focus(K(this).fh))
      .key_context("HvView")
      .on_mouse_down("left", (_e, cx) => { globalThis.__hvZone = "view"; if (!K(this).fh) { try { K(this).fh = cx.focus_handle(); } catch { return; } } K(this).fh.focus(); })
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => {
        measure("center")(size);
        const dh = Math.abs(size.height - (this.height ?? 0)) > 8;
        if (dh) this.height = size.height;
        if (Math.abs(size.width - this.width) > 8) { this.width = size.width; cx.notify(); } else if (dh && view().tab === "activity") cx.notify();
      })
      // The agent map fills the center edge to edge (no page scroll, no gutter).
      .child(v.kind === "map" ? body : scrollY("mp-view-scroll", v_flex().px(24).pt(16).pb(24).gap(16).child(body)));
  }

  // ------------------------------------------------------------ keyboard
  // A row of a keyboard list: { key, open, ref?, col? } (col: board column). Marks the selected one.
  navMark(el, item, card = false) {
    (K(this).nav ??= []).push(item);
    K(this).navSel ??= {};
    const t = theme();
    const on = K(this).navSel[this.navView] === item.key;
    return el.when(on, (e) => (card ? e.bg(t.hover).border_color(t.input) : e.bg(t.hover)))
      .on_mouse_down("left", () => { K(this).navSel[this.navView] = item.key; });
  }
  onKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform) return;
    const stop = () => { cx.stop_propagation(); cx.notify(); };
    // Agent map: Tab / arrows cycle ghosts, Enter opens the card, Esc closes it, c / t / o act (mapview.js).
    if (view().kind === "map" && (k === "escape" || K(this).fh?.is_focused()) && mapKey(e, cx)) { stop(); return; }
    if (k === "escape") {
      if (shared("mp.taskPanel")) { closeTaskPanel(); stop(); return; }
      if (this.navEsc) { this.navEsc(); stop(); return; } // e.g. clear the agents table selection
      if (view().kind === "dashboard") { dashKey(e, cx); return; }
      // Nothing to close: up a level, to the explorer row of this view (IDE: Esc leaves the editor area).
      if (K(this).fh?.is_focused()) { setShared("mp.focus", { to: "sidebar", at: Date.now() }); stop(); }
      return;
    }
    if (!K(this).fh?.is_focused()) return; // typing in a search or reply field
    // Linear-style "G then a letter" (1.2 s).
    if (this.gAt && Date.now() - this.gAt < 1200) {
      this.gAt = 0;
      const go = { d: "dashboard", m: "mailbox", t: "tokens", s: "settings", c: "clipboard", k: "skills", i: "mcp", p: "focus-sidebar", v: "explorer-machines", a: "explorer-agents" }[k];
      if (go) { import("./palette.js").then((p) => p.runCommand(go)); stop(); }
      return;
    }
    if (k === "g" && !m.shift) { this.gAt = Date.now(); stop(); return; }
    if (k === "c" && !m.shift && !K(this).nav?.find((x) => x.key === K(this).navSel[this.navView])?.keys?.c) { setShared("mp.focus", { to: "chat", at: Date.now() }); stop(); return; }
    if (k === "?" || (k === "/" && m.shift)) { import("./palette.js").then((p) => p.openPaletteWith({ mode: "keys" })); stop(); return; }
    if (k === "/") { if (hasViewSearch(view())) this.taskSearchState().focus(); else setShared("mp.focus", { to: "find", at: Date.now() }); stop(); return; }
    if (view().kind === "dashboard") { dashKey(e, cx); return; }
    const list = K(this).nav;
    // List-level keys (sort 1-8 / select all in the agents table, filters 1-6 in the activity view).
    if (this.navKeys?.[k] && !list.find((x) => x.key === K(this).navSel[this.navView])?.keys?.[k]) { this.navKeys[k](cx); stop(); return; }
    if (!list.length) return;
    let i = list.findIndex((x) => x.key === K(this).navSel[this.navView]);
    const cur = list[i];
    // Row keys first (Space selects a row in the agents table instead of opening its actions).
    if (cur?.keys?.[k] && !["j", "k", "up", "down", "home", "end", "enter"].includes(k)) { cur.keys[k](cx); stop(); return; }
    const pick = (x) => { if (x) K(this).navSel[this.navView] = x.key; };
    const board = list.some((x) => x.col != null);
    if (k === "j" || k === "down") pick(list[i < 0 ? 0 : Math.min(list.length - 1, i + 1)]);
    else if (k === "k" || k === "up") pick(list[i < 0 ? 0 : Math.max(0, i - 1)]);
    else if (k === "home") pick(list[0]);
    else if (k === "end") pick(list[list.length - 1]);
    else if (k === "enter") { if (cur) cur.open(); else pick(list[0]); }
    else if (board && (k === "left" || k === "right" || k === "h" || k === "l") && !m.shift) {
      // Board: the same row in the next non-empty column.
      const d = k === "left" || k === "h" ? -1 : 1;
      if (!cur) { pick(list[0]); stop(); return; }
      const cols = [...new Set(list.map((x) => x.col))].sort((a, b) => a - b);
      const ci = cols.indexOf(cur.col) + d;
      if (ci < 0 || ci >= cols.length) return;
      const here = list.filter((x) => x.col === cur.col), there = list.filter((x) => x.col === cols[ci]);
      pick(there[Math.min(here.indexOf(cur), there.length - 1)]);
    }
    else if (k === "right" || k === "l" || k === "." || k === "space") { if (cur?.ref) openActions(cur.ref); else if (!cur) pick(list[0]); }
    else if (cur?.keys?.[k]) cur.keys[k](cx);
    else return;
    stop();
  }

  projectView(t, v) {
    const p = this.project;
    if (!p || p.slug !== v.slug) {
      if (v.slug) return v_flex().gap(16).child(div().h(56).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border)).child(skeleton(t, 6));
      return emptyLine(t, "mp-new-proj", "No project yet.", ["New project", () => openForm("project-new")]);
    }
    // Loose agents are projects of their own: their page (and its full Activity).
    if (p.loose) return v.tab === "activity" ? activityView(this, t, p) : this.agentPage(t, p, p.agents[0]?.name ?? p.name);
    if (v.tab === "agent" && v.agent) return this.agentPage(t, p, v.agent);
    switch (v.tab ?? "overview") {
      case "agents": return agentsTab(this, t, p);
      // Runs of every agent (Overview's "Open full activity", the explorer, the palette, a daily report).
      case "activity": return activityView(this, t, p);
      case "tasks": return this.tasksTab(t, p);
      case "epics": return this.epicsTab(t, p);
      case "resources": // old name (code sources + machines); sources have no UI any more
      case "machines": return this.machinesCard(t, p, true);
      case "credentials": return this.projectCredsTab(t, p);
      case "settings": return this.settingsTab(t, p);
      default: return this.overviewTab(t, p);
    }
  }

  // ------------------------------------------------------------ KPIs
  // One stat strip (Vercel / Linear project header): cells split by 1px dividers inside a single
  // bordered panel — label 11px dim, value 20px tabular, an optional colored note. No icon tiles.
  kpi(t, id, iconName, color, value, label, sub) {
    return v_flex().id(id).flex_1().min_w(0).h(56).px(T.pad.card).justify_center().gap(T.sp.xxs)
      .child(div().text_size(T.text.xs).text_color(t.muted).truncate().child(label))
      .child(h_flex().gap(T.sp.md).items_baseline()
        .child(div().text_size(T.text.xl).font_semibold().line_height(`${T.lh.base}px`).text_color(value ? t.foreground : t.dim).child(String(value)))
        .when(Boolean(sub), (el) => el.child(div().min_w(0).text_size(T.text.xs).text_color(color).truncate().child(sub))));
  }
  kpis(t, p) {
    const live = p.agents.map((a) => liveAgent(p, a.name)).filter(Boolean);
    const open = p.tasks.filter((x) => x.status !== "done").length;
    const done = p.tasks.filter((x) => x.status === "done").length;
    const doing = p.tasks.filter((x) => x.status === "doing").length;
    const blocked = p.tasks.filter((x) => x.status === "blocked").length;
    const review = p.tasks.filter((x) => x.status === "review").length;
    const needs = (shared("mp.mailboxBySlug") ?? {})[p.slug] ?? 0;
    const cells = [
      this.kpi(t, "mp-k-agents", "bot", OK, p.agents.length, "Agents", live.length ? `${live.length} live` : null),
      this.kpi(t, "mp-k-tasks", "list", INFO, open, "Open tasks", review ? `${review} in review` : null),
      this.kpi(t, "mp-k-doing", "loader", WARN, doing, "In progress"),
      this.kpi(t, "mp-k-blocked", "alert", BAD, blocked, "Blocked", blocked ? "needs a look" : null),
      this.kpi(t, "mp-k-done", "check-circle", OK, done, "Completed"),
      // "Needs you": open Mailbox items for this project; click → Mailbox.
      this.kpi(t, "mp-k-needs", "inbox", WARN, needs, "Needs you", needs ? "open mailbox" : null)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { openMailbox(); showCenter("mp-view"); }),
    ];
    // Six cells in one row; two rows of three when narrow. Dividers, not boxes.
    const per = this.contentW() >= 720 ? 6 : 3;
    const rows = [];
    for (let i = 0; i < cells.length; i += per) rows.push(cells.slice(i, i + per));
    return v_flex().id("mp-kpis").w_full().rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
      .children(rows.map((r, ri) => h_flex().id(`mp-kpis-r${ri}`).w_full().when(ri > 0, (e) => e.border_t_1().border_color(t.border))
        .children(r.map((c, ci) => (ci > 0 ? c.border_l_1().border_color(t.border) : c)))));
  }

  // Width available to content inside the scroll area (padding and scrollbar removed).
  contentW() { return Math.max(320, Math.floor(this.width) - 40 - 1); }

  // ------------------------------------------------------------ agents
  // The Agents tab (sortable table + bulk actions) and Overview's summary live in agentsview.js.

  // ------------------------------------------------------------ overview
  overviewTab(t, p) {
    return v_flex().gap(16)
      .child(this.kpis(t, p))
      .child(this.todayCard(t, p))
      .child(agentsSummary(this, t, p))
      .child(activitySection(this, t, p));
  }

  // "Today" (last 24 h): one short list, a colored dot per kind, newest first within each kind.
  todayCard(t, p) {
    const stats = vmStats();
    const DAY = 24 * 60 * 60 * 1000;
    const MAX = this.todayAll ? 50 : 6;
    const recent = (ts) => Boolean(ts) && Date.now() - new Date(ts) < DAY;
    const open = (x) => () => openTaskPanel(p.slug, x.id);
    const KIND = { needs: ["Needs you", WARN], blocked: ["Blocked", BAD], started: ["Started", INFO], done: ["Done", OK] };
    const items = [];
    // "Needs you" = the same as the Mailbox: approval requests and questions (a "?" or "Odpowiedz") to you that
    // you have not answered yet. Plain reports to you are not listed (they are in the chat). Click: Mailbox.
    const ev = this.events ?? [];
    ev.forEach((e, i) => {
      if (e.to !== "ty" || e.from === "ty" || !recent(e.ts)) return;
      if (e.type === "approval") {
        const n = /^Approval #(\d+)/.exec(e.text ?? "")?.[1];
        if (n && ev.slice(i + 1).some((x) => x.from === "ty" && new RegExp(`^(Approved|Rejected) #${n}\\b`).test(x.text ?? ""))) return;
      } else if (e.type === "message") {
        if (!MAIL_ASK.test(e.text ?? "") || ev.slice(i + 1).some((x) => x.from === "ty" && x.to === e.from && (e.task == null || String(x.task ?? "") === String(e.task)))) return;
      } else return;
      items.push({ kind: "needs", text: `${e.from}: ${e.text}`, time: fmtTime(e.ts), go: () => { openMailbox(); showCenter("mp-view"); } });
    });
    items.reverse();
    // An agent waiting at its own prompt, or a machine offline: not a question to you, so not "needs you".
    for (const a of p.agents) { const live = liveAgent(p, a.name); if (live?.status === "blocked") items.push({ kind: "blocked", text: `${a.name} waits at its terminal prompt`, time: "now", go: () => { run("agent.focus", { terminal: live.address }); showCenter("mp-terms"); } }); }
    for (const n of p.machines) { const st = stats[n]; if (st && !st.ok) items.push({ kind: "blocked", text: `${n} is offline`, time: "", go: () => openVm(n) }); }
    const byTs = (k) => (a, b) => String(b[k] ?? "").localeCompare(String(a[k] ?? ""));
    for (const x of p.tasks.filter((x) => x.status === "blocked")) items.push({ kind: "blocked", text: `${x.title}${x.blocked_reason ? " — " + x.blocked_reason : ""}`, time: "", go: open(x) });
    for (const x of p.tasks.filter((x) => (x.status === "doing" || x.status === "review") && recent(x.started)).sort(byTs("started"))) items.push({ kind: "started", text: x.title, time: fmtTime(x.started), go: open(x) });
    for (const x of p.tasks.filter((x) => x.status === "done" && recent(x.completed)).sort(byTs("completed"))) items.push({ kind: "done", text: x.title, time: fmtTime(x.completed), go: open(x) });
    const counts = Object.keys(KIND).map((k) => [k, items.filter((x) => x.kind === k).length]).filter(([, n]) => n);
    const legend = h_flex().gap(12).items_center().children(counts.map(([k, n]) => h_flex().gap(6).items_center()
      .child(div().size(T.dot).rounded_full().bg(KIND[k][1]))
      .child(div().text_size(T.text.xs).text_color(t.muted).child(`${n} ${KIND[k][0].toLowerCase()}`))));
    return card(t, "mp-today")
      .child(cardHeader(t, "Today", counts.length ? legend : null))
      .when(items.length === 0, (el) => el.child(div().pb(T.sp.sm).child(emptyLine(t, "mp-today-empty", "Nothing yet today.", ["New task", () => openForm("task-add", { project: p.slug })]))))
      .child(v_flex().px(8).pb(8)
        .children(items.slice(0, MAX).map((it, i) => h_flex().id(`mp-today-${i}`).h(32).px(8).gap(8).items_center().rounded(T.r.panel)
          .when(Boolean(it.go), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { it.go(); cx.notify(); }))
          .child(div().flex_none().size(T.dot).rounded_full().bg(KIND[it.kind][1]))
          // One line: messages with line breaks used to spill over the next rows.
          .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).child(String(it.text ?? "").replace(/\s+/g, " ")))
          .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(it.time))))
        .when(items.length > MAX, (el) => el.child(h_flex().id("mp-today-more").h(28).px(8).items_center().rounded(T.r.panel).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.todayAll = !this.todayAll; cx.notify(); })
          .child(div().text_size(T.text.xs).text_color(t.accent).child(`+${items.length - MAX} more`))))
        .when(Boolean(this.todayAll) && items.length > 6, (el) => el.child(h_flex().id("mp-today-less").h(28).px(8).items_center().rounded(T.r.panel).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.todayAll = false; cx.notify(); }).child(div().text_size(T.text.xs).text_color(t.accent).child("Show less")))));
  }

  // ------------------------------------------------------------ machines
  // One row per machine (status, CPU/RAM/disk, who can use it). Used on Overview and in the
  // Machines tab, so both read the same and never end in a half-empty tile row.
  machineRow(t, p, n, full) {
    const stats = vmStats();
    const m = this.machines.find((x) => x.name === n);
    const st = stats[n]; const [label, color] = vmHealth(st);
    const W = this.width;
    const nameW = W > 1100 ? 220 : 170;
    const showSpark = full && W > 1180, showWho = full && W > 1000;
    const who = p.agents.filter((a) => !(a.machines ?? []).length || a.machines.includes(n)).map((a) => a.name);
    const stat = (lbl, v) => h_flex().flex_1().min_w(0).gap(8).items_center()
      .child(div().flex_none().w(30).text_size(T.text.xs).text_color(t.dim).child(lbl))
      .child(div().flex_1().min_w(24).child(meter(t, v, null, 5)))
      .child(div().flex_none().w(36).text_size(T.text.xs).text_color(t.muted).text_right().child(pct(v)));
    const rm = `mp-pm-rm-${n}`;
    return h_flex().id(`mp-vm-row-${n}`).flex_none().h(T.h.rowTall).px(12).gap(12).items_center().border_t_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => openVm(n))
      .child(div().relative().flex_none().child(tile(n, { kind: "vm", size: 22, radius: 6 }))
        .child(div().absolute().right(-2).bottom(-2).size(8).rounded_full().bg(color).border_2().border_color(t.surface)))
      .child(v_flex().w(nameW).flex_none().min_w(0)
        .child(div().text_size(T.text.sm).font_medium().truncate().child(n))
        .child(div().text_size(T.text.xs).line_height(`${T.lh.xs}px`).text_color(st && !st.ok ? BAD : t.muted).truncate().child(st && !st.ok ? label : st?.os || m?.os || m?.host || "")))
      .child(h_flex().flex_1().min_w(0).gap(16).child(stat("CPU", st?.cpu)).child(stat("RAM", st?.ram)).child(stat("Disk", st?.disk)))
      .when(showSpark, (el) => el.child(spark(`pm-${n}`, (st?.cpuHistory ?? []).slice(-30), t.accent, 80, 26)))
      .when(showWho, (el) => el.child(h_flex().id(`mp-pm-who-${n}`).w(96).flex_none().gap(6).items_center()
        .tooltip(who.length ? who.join(", ") : "No agents have access")
        .child(iconEl("users", t.dim, 13)).child(div().text_size(T.text.xs).text_color(t.muted).child(`${who.length} agent${who.length === 1 ? "" : "s"}`))))
      .when(full, (el) => el.child(h_flex().flex_none().gap(4)
        .child(iconButton(t, `mp-pm-ssh-${n}`, "terminal", () => openSsh(n, p), "Open editor", { filled: true }))
        .child(this.confirm === rm
          ? iconButton(t, `${rm}-sure`, "unlink", (_e, cx) => { this.confirm = null; this.act(cx, ["project", "detach", n], { p: p.slug }, `Detached ${n}`); }, "Click again to detach", { filled: true, color: BAD })
          : iconButton(t, rm, "unlink", (_e, cx) => { this.confirm = rm; cx.notify(); cx.timer.after(3000, (cx) => { if (this.confirm === rm) { this.confirm = null; cx.notify(); } }); }, "Detach from project (the machine stays)", { filled: true }))));
  }

  machinesCard(t, p, full) {
    // flex_none: inside the page's scrolling column the card must keep its full height (it used to
    // shrink to the viewport and clip the rows below, with nothing to scroll to).
    return card(t, full ? "mp-pm" : "mp-ov-vms").flex_none().overflow_hidden()
      .child(cardHeader(t, `Machines (${p.machines.length})`, full
        ? h_flex().gap(8)
          .child(button(t, "mp-pm-attach", "Attach Existing", () => openForm("vm-attach", { project: p.slug, attached: p.machines }), { small: true, ghost: true, iconName: "unlink" }))
          .child(button(t, "mp-pm-new", "New Machine", () => openForm("vm-add", { project: p.slug }), { small: true, ghost: true, iconName: "plus" }))
        : null))
      .when(p.machines.length === 0, (el) => el.child(emptyLine(t, "mp-pm-empty", "No machines attached.", ["Attach one", () => openForm("vm-attach", { project: p.slug, attached: p.machines })])))
      .children(p.machines.map((n) => this.machineRow(t, p, n, full)));
  }

  // ------------------------------------------------------------ agent page
  // One page for project agents and loose agents. Header (avatar, name, status, engine · role, project badge
  // or "loose", actions), one property strip (risk, auto-restart, model, machines, tokens, last active), then
  // full-width sections on one left edge: Now (task, action, queue), Machine access, Recent activity (runs).
  agentPage(t, p, name) {
    const a = p.agents.find((x) => x.name === name);
    if (!a) return emptyLine(t, "mp-ag-gone", `${name} is not in ${p.name} any more.`, ["Open Agents", () => setShared("mp.view", { kind: "project", slug: p.slug, tab: "agents" })]);
    const f = agentFacts(this, p, a);
    const live = f.live;
    const W = this.contentW();
    const ref = p.loose ? { kind: "loose", slug: p.slug, label: name } : { kind: "agent", slug: p.slug, name };
    // Editable access state (kept while the page is open; saved on every change). Loose agents: every machine
    // is listed; switching one on attaches it to the agent's own project.
    if (this.accessFor !== `${p.slug}/${name}/${p.machines.join(",")}/${(a.machines ?? []).join(",")}`) {
      this.accessFor = `${p.slug}/${name}/${p.machines.join(",")}/${(a.machines ?? []).join(",")}`;
      const all = !(a.machines ?? []).length;
      const names = p.loose ? this.machines.map((m) => m.name) : p.machines;
      this.agentAccess = Object.fromEntries(names.map((m) => [m, { on: p.machines.includes(m) && (all || a.machines.includes(m)), sudo: (a.sudo ?? []).includes(m) }]));
    }
    const saveAccess = (cx) => {
      if (!p.loose) return this.act(cx, ["agent", "set", name], { p: p.slug, ...accessArgs(this.agentAccess) });
      const acc = this.agentAccess;
      const on = Object.keys(acc).filter((m) => acc[m].on);
      cx.spawn(async (cx) => {
        for (const m of on.filter((m) => !p.machines.includes(m))) await hp(["project", "attach", m], { p: p.slug });
        for (const m of p.machines.filter((m) => !on.includes(m))) await hp(["project", "detach", m], { p: p.slug });
        const r = await hp(["agent", "set", name], { p: p.slug, machines: on.join(","), sudo: on.filter((m) => acc[m].sudo).join(",") });
        if (!r.ok) toast("Could not update access", r.err, "error");
        this.reload(cx);
      });
    };

    // ---- header
    const badge = p.loose
      ? h_flex().flex_none().h(18).px(T.sp.sm).items_center().rounded(T.r.chip).bg(t.raised).text_size(T.text.xs).text_color(t.muted).child("loose")
      : h_flex().id("mp-ag-proj").flex_none().h(18).px(T.sp.sm).gap(T.sp.xs).items_center().rounded(T.r.chip).bg(t.raised).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`Open ${p.name}`).on_click(() => { selectProject(p.slug, "overview"); showCenter("mp-view"); })
        .child(div().size(T.dot).rounded(2).bg(p.color ?? colorFor(`project:${p.name}`))).child(div().text_size(T.text.xs).text_color(t.muted).child(p.name));
    const actions = h_flex().flex_none().gap(T.sp.sm).items_center()
      .child(live
        ? this.confirmButton(t, "mp-ag-stop", "Stop", () => { markManualStop(p.slug, name); run("terminal.kill", { terminal: live.address }); }, { small: true, iconName: "square" })
        : button(t, "mp-ag-start", "Start", () => startAgent(p, a, undefined, { show: true }), { small: true, primary: true, iconName: "play" }))
      .child(button(t, "mp-ag-task", "Assign Task", () => openForm("task-add", { project: p.slug, for: name }), { small: true, ghost: true, iconName: "plus" }))
      .child(button(t, "mp-ag-chat", "Chat", () => setShared("mp.chatGo", { name, text: "", at: Date.now() }), { small: true, ghost: true, iconName: "messages" }))
      .child(iconButton(t, "mp-ag-access", "key", () => openForm("project-secrets", { project: p.slug }), "Project access (tokens it may use)", { size: T.h.btnSm }))
      .child(iconButton(t, "mp-ag-more", "more", () => openActions(ref), "More: jump to terminal, remove…  (.)", { size: T.h.btnSm }));
    const head = (W < 700 ? v_flex().gap(T.sp.md).items_start() : h_flex().gap(T.sp.lg).items_center()).on_size_change(measure("agent.head"))
      .child(h_flex().flex_1().min_w(0).gap(T.sp.lg).items_center()
        .child(agentAvatar(t, name, live, 36))
        .child(v_flex().flex_1().min_w(0).gap(T.sp.xxs)
          .child(h_flex().gap(T.sp.md).items_center()
            .child(div().min_w(0).truncate().text_size(T.text.lg).font_semibold().child(name))
            .child(live ? pill(t, STATUS_EN[live.status] ?? live.status, statusColor(t, live.status)) : pill(t, "Stopped", t.dim))
            // Team lead: answers team messages and plans epics (… → Set as lead on another agent).
            .when(!p.loose && leadOf(p) === name, (el) => el.child(h_flex().id("mp-ag-lead").flex_none().h(T.h.chip).px(T.sp.sm).items_center().rounded(T.r.chip).bg(t.raised)
              .tooltip("Team lead: answers the team's messages and plans epics").child(div().text_size(T.text.xs).text_color(t.muted).child("Team lead")))))
          .child(h_flex().min_w(0).gap(T.sp.sm).items_center()
            .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(`${f.engine}${a.role ? " · " + a.role : ""}`))
            .child(badge))))
      .child(actions);

    // ---- property strip: every cell the same height, label above value.
    const tk = actTokens(p.slug, name);
    const sum = (v) => v[0] + v[1] + v[2] + v[3];
    const autoOn = p.loose ? a.autorestart === true : a.autorestart !== false;
    const cell = (id, label, content, tip, grow = true) => {
      let el = v_flex().id(id).min_w(0).h(60).px(T.pad.card).justify_center().gap(T.sp.xs)
        .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(label))
        .child(typeof content === "string" ? h_flex().h(T.h.btnSm).items_center().min_w(0).truncate().text_size(T.text.sm).text_color(t.foreground).child(content) : content);
      el = grow ? el.flex_1() : el.flex_none();
      return tip ? el.tooltip(tip) : el;
    };
    const machinesN = Object.values(this.agentAccess ?? {}).filter((x) => x.on).length;
    const cells = [
      cell("mp-ag-p-risk", "Risk", riskSeg(t, "mp-ag-risk", riskOf(a), (cx, val) => {
        a.risk = val;
        this.act(cx, ["agent", "set", name], { p: p.slug, risk: val }, `${name}: ${RISKS.find((r) => r[0] === val)[1]}`);
        cx.notify();
      }), null, false),
      cell("mp-ag-p-auto", "Auto-restart", h_flex().h(T.h.btnSm).gap(T.sp.md).items_center()
        .child(switchEl(t, "mp-ag-auto-sw", autoOn, (cx) => {
          a.autorestart = !autoOn;
          this.act(cx, ["agent", "set", name], { p: p.slug, autorestart: a.autorestart ? "on" : "off" });
          cx.notify();
        }))
        .child(div().text_size(T.text.sm).text_color(autoOn ? t.foreground : t.muted).child(autoOn ? "On" : "Off")),
        p.loose ? "Start it again when it stops while you wait for its answer" : "Start it again when it stops while it still has To Do / In Progress tasks", false),
      cell("mp-ag-p-model", "Model", f.model || f.engine, `${f.engine}${f.model ? " · " + f.model : ""}`),
      cell("mp-ag-p-vms", "Machines", machinesN ? `${machinesN}${!p.loose && f.allMachines ? " (all)" : ""}` : "None",
        Object.keys(this.agentAccess ?? {}).filter((m) => this.agentAccess[m].on).join(", ") || "No machine access"),
      cell("mp-ag-p-tok", "Tokens today · 7d", tk.has ? `${fmtTok(sum(tk.today))} · ${fmtTok(sum(tk.d7))}` : "–",
        tk.has ? `Today ${fmtTok(sum(tk.today))} · 7 days ${fmtTok(sum(tk.d7))} · total ${fmtTok(sum(tk.total))}` : "No sessions recorded yet"),
      cell("mp-ag-p-last", "Last active", live?.status === "working" ? "now" : f.lastT ? relShort(f.lastT) : "—", f.lastT ? new Date(f.lastT).toLocaleString() : "No activity recorded"),
    ];
    const per = W >= 1000 ? 6 : 3;
    const stripRows = [];
    for (let i = 0; i < cells.length; i += per) stripRows.push(cells.slice(i, i + per));
    const strip = v_flex().id("mp-ag-props").w_full().rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
      .children(stripRows.map((r, ri) => h_flex().id(`mp-ag-props-r${ri}`).w_full().when(ri > 0, (e) => e.border_t_1().border_color(t.border))
        .children(r.map((c, ci) => (ci > 0 ? c.border_l_1().border_color(t.border) : c)))));

    return v_flex().w_full().gap(T.sp.xl)
      .child(head)
      .child(strip)
      .child(this.agentNow(t, p, a, f))
      // Two rows of two panels, same height each (6 rows, then the list scrolls; each has its own search).
      .child(v_flex().w_full().gap(T.sp.xl)
        .child(h_flex().w_full().gap(T.sp.lg).items_start()
          .child(this.agentAccessPanel(t, p, saveAccess, machinesN))
          .child(this.agentCredsPanel(t, p, a)))
        .child(h_flex().w_full().gap(T.sp.lg).items_start().children(kitPanels(this, t, p, a, openForm)))
        .child(div().text_size(T.text.xs).text_color(t.dim).child("Skills and MCP servers apply the next time the agent starts.")))
      .child(this.agentRuns(t, p, name));
  }

  // "Now": the current task (progress) and what the agent is doing this minute, then its queue.
  agentNow(t, p, a, f) {
    const name = a.name;
    const live = f.live;
    const mine = p.tasks.filter((x) => x.agent === name);
    const order = ["doing", "review", "blocked", "todo", "backlog"];
    const queue = order.flatMap((s) => mine.filter((x) => x.status === s)).filter((x) => x.id !== f.cur?.id);
    const k = f.now ? KIND[f.now.kind] ?? KIND.tool : null;
    const openTasks = () => { this.taskFilter = name; this.taskMode = "agents"; this.laneOpen = { [name]: true }; this.taskFor = p.slug; setShared("mp.view", { kind: "project", slug: p.slug, tab: "tasks" }); };
    const doing = f.cur
      ? h_flex().id("mp-ag-cur").w_full().min_h(T.h.rowTall).px(T.pad.card).gap(T.sp.md).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => openTaskPanel(p.slug, f.cur.id))
        .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[f.cur.status]))
        .child(div().flex_none().w(36).text_size(T.text.xs).text_color(t.dim).child(`#${f.cur.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).font_medium().child(f.cur.title))
        .when(f.cur.status === "blocked" && Boolean(f.cur.blocked_reason), (e) => e.child(div().flex_none().max_w(260).truncate().text_size(T.text.xs).text_color(BAD).child(f.cur.blocked_reason)))
        .child(div().flex_none().w(120).child(meter(t, f.cur.progress ?? 0, null, 4)))
        .child(div().flex_none().w(36).text_right().text_size(T.text.xs).text_color(t.muted).child(`${f.cur.progress ?? 0}%`))
      : h_flex().w_full().h(T.h.rowTall).px(T.pad.card).items_center().text_size(T.text.sm).text_color(t.dim)
        .child(p.loose ? (live ? "Talking with you in the chat." : "Stopped. A message in the chat starts it.") : live ? "No task in progress." : "Stopped · no task in progress.");
    const action = h_flex().w_full().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center().border_t_1().border_color(t.border)
      .child(k ? iconEl(k[0], k[1], 13) : iconEl(live ? "clock" : "square", t.dim, 13))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(f.now ? t.foreground : t.dim)
        .child(f.now ? f.now.text : live ? (live.status === "blocked" ? "Waiting for your answer" : STATUS_EN[live.status] ?? live.status) : "Not running"))
      .when(Boolean(f.now?.t), (e) => e.child(relTime(t, "mp-ag-now-ts", f.now.t)));
    const shown = queue.slice(0, 4);
    return v_flex().w_full()
      .child(section(t, "Now", { right: mine.length ? h_flex().id("mp-ag-tasks-all").gap(T.sp.xs).items_center().cursor_pointer().on_click((_e, cx) => { openTasks(); cx.notify(); })
        .child(div().text_size(T.text.xs).font_medium().text_color(t.accent).child(`All tasks (${mine.length})`)).child(iconEl("chevron-right", t.accent, 11)) : null }))
      .child(card(t, "mp-ag-now").overflow_hidden()
        .child(doing)
        .child(action)
        .when(shown.length > 0, (e) => e.child(v_flex().border_t_1().border_color(t.border).px(T.sp.xs).py(T.sp.xs)
          .child(div().px(T.sp.md).h(20).text_size(T.text.xs).text_color(t.dim).child(`Queue · ${queue.length}`))
          .children(this.agentTaskLines(t, shown)))));
  }

  // Machine access, compact: one 28 px row per machine (health, access and sudo switches).
  agentAccessList(t, p, save) {
    const acc = this.agentAccess ?? {};
    const names = Object.keys(acc);
    const stats = vmStats();
    if (!names.length) return card(t, "mp-ag-acc").child(emptyLine(t, "mp-ag-acc-empty", p.loose ? "No machines yet." : "This project has no machines yet.",
      p.loose ? ["Add a machine", () => openForm("vm-add", {})] : ["Attach one", () => openForm("vm-attach", { project: p.slug, attached: p.machines })]));
    const rows = names.map((n, i) => {
      const x = acc[n];
      const m = this.machines.find((y) => y.name === n);
      const [label, color] = vmHealth(stats[n]);
      const sudoAvail = Boolean(m?.sudo);
      return h_flex().id(`mp-ag-acc-${i}`).flex_none().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center()
        .child(tile(n, { kind: "vm", size: 16, radius: 4 }))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(x.on ? t.foreground : t.muted).child(n))
        .child(h_flex().flex_none().w(110).gap(T.sp.sm).items_center().child(div().size(T.dot).rounded_full().bg(color)).child(div().text_size(T.text.xs).text_color(t.dim).child(label)))
        .child(h_flex().flex_none().w(52).justify_center()
          .child(switchEl(t, `mp-ag-acc-on-${i}`, x.on, (cx) => { x.on = !x.on; if (!x.on) x.sudo = false; save(cx); cx.notify(); })))
        .child(h_flex().id(`mp-ag-acc-sut-${i}`).flex_none().w(52).justify_center().tooltip(sudoAvail ? "Let this agent use sudo here" : "Sudo is off for this machine")
          .child(switchEl(t, `mp-ag-acc-su-${i}`, x.sudo, (cx) => { x.sudo = !x.sudo; if (x.sudo) x.on = true; save(cx); cx.notify(); }, !sudoAvail)));
    });
    // Dozens of machines: a fixed-height scrolling list instead of a page-long one.
    return card(t, "mp-ag-acc").overflow_hidden().py(T.sp.xs)
      .child(names.length > 6 ? scrollY("mp-ag-acc-scroll", v_flex().max_h(T.h.row * 6).children(rows), { grow: false }) : v_flex().children(rows));
  }

  // Machine access panel: access + sudo switch per machine.
  agentAccessPanel(t, p, save, machinesN) {
    const acc = this.agentAccess ?? {};
    const names = Object.keys(acc);
    const q = this.agQv?.acc ?? "";
    const stats = vmStats();
    const rows = names.filter((n) => !q || q.split(/\s+/).every((w) => n.toLowerCase().includes(w))).map((n) => {
      const x = acc[n], i = names.indexOf(n);
      const m = this.machines.find((y) => y.name === n);
      const [label, color] = vmHealth(stats[n]);
      const sudoAvail = Boolean(m?.sudo);
      return h_flex().id(`mp-ag-acc-${i}`).flex_none().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center().tooltip(`${n} · ${label}`)
        .child(div().relative().flex_none().child(tile(n, { kind: "vm", size: 16, radius: 4 }))
          .child(div().absolute().right(-2).bottom(-2).size(6).rounded_full().bg(color)))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(x.on ? t.foreground : t.muted).child(n))
        .child(h_flex().flex_none().w(44).justify_center()
          .child(switchEl(t, `mp-ag-acc-on-${i}`, x.on, (cx) => { x.on = !x.on; if (!x.on) x.sudo = false; save(cx); cx.notify(); })))
        .child(h_flex().id(`mp-ag-acc-sut-${i}`).flex_none().w(44).justify_center().tooltip(sudoAvail ? "Let this agent use sudo here" : "Sudo is off for this machine")
          .child(switchEl(t, `mp-ag-acc-su-${i}`, x.sudo, (cx) => { x.sudo = !x.sudo; if (x.sudo) x.on = true; save(cx); cx.notify(); }, !sudoAvail)));
    });
    return listPanel(t, { id: "mp-ag-acc", title: "Machine access", count: names.length ? `${machinesN} of ${names.length}` : null,
      right: h_flex().pr(T.pad.card).gap(0).text_size(T.text.xs).text_color(t.dim).child(div().w(44).text_center().child("Access")).child(div().w(44).text_center().child("Sudo")),
      search: searchField(t, "mp-ag-acc-q", this.agQ("acc"), q, () => this.agQClear("acc")), rows,
      empty: names.length ? emptyLine(t, "mp-ag-acc-none", "No matches.")
        : emptyLine(t, "mp-ag-acc-empty", p.loose ? "No machines yet." : "This project has no machines yet.",
          p.loose ? ["Add a machine", () => openForm("vm-add", {})] : ["Attach one", () => openForm("vm-attach", { project: p.slug, attached: p.machines })]) });
  }

  // Credentials panel: tokens / passwords this agent can use (hp checks: project shared + agent list).
  agentCredsPanel(t, p, a) {
    const list = (this.secrets ?? []).slice().sort((x, y) => x.name.localeCompare(y.name));
    const q = this.agQv?.cred ?? "";
    const hasIt = (s) => (s.projects ?? []).includes(p.slug) && (!(s.agents ?? []).length || s.agents.includes(a.name));
    const on = list.filter(hasIt).length;
    const rows = list.filter((s) => !q || q.split(/\s+/).every((w) => `${s.name} ${typeLabel(s)} ${s.host ?? ""} ${s.user ?? ""}`.toLowerCase().includes(w))).map((s) => {
      const has = hasIt(s);
      const { prov } = typeOf(s);
      return h_flex().id(`mp-ag-cred-${s.name}`).flex_none().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center().tooltip(`${s.name} · ${typeLabel(s)}`)
        .child(tile(s.name, { size: 16, glyph: prov.glyph, color: prov.color, radius: 4 }))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(has ? t.foreground : t.muted).child(s.name))
        .child(h_flex().flex_none().w(52).justify_center()
          .child(switchEl(t, `mp-ag-cred-sw-${s.name}`, has, (cx) => this.toggleAgentSecret(cx, p, a, s, has))));
    });
    return listPanel(t, { id: "mp-ag-cred", title: "Credentials", count: list.length ? `${on} of ${list.length}` : null,
      search: searchField(t, "mp-ag-cred-q", this.agQ("cred"), q, () => this.agQClear("cred")), rows,
      empty: list.length ? emptyLine(t, "mp-ag-cred-none", "No matches.") : emptyLine(t, "mp-ag-cred-empty", "No credentials yet.", ["Add one", () => openForm("secret-add", {})]) });
  }
  // A secret for ONE agent: shared with its project, and when the secret has an agent list, on that list.
  // Turning it on for one agent of a bigger project keeps the others as they were (an agent list is set);
  // turning it off removes only this agent.
  toggleAgentSecret(cx, p, a, s, has) {
    cx.spawn(async (cx) => {
      const projects = this.projects ?? [];
      const agentsOf = (slugs) => [...new Set(projects.filter((x) => slugs.includes(x.slug)).flatMap((x) => (x.agents ?? []).map((y) => y.name)))];
      const shared = s.projects ?? [], list = s.agents ?? [];
      const others = (p.agents ?? []).filter((y) => y.name !== a.name).length;
      const run1 = async (args, opts) => { const r = await hp(args, opts); if (!r.ok) throw new Error(r.err); };
      try {
        if (!has) {
          const was = shared.includes(p.slug);
          if (!was) await run1(["secret", "share", s.name], { p: p.slug });
          if (list.length) await run1(["secret", "set", s.name], { agents: [...new Set([...list, a.name])].join(",") });
          else if (!was && others) await run1(["secret", "set", s.name], { agents: [...new Set([...agentsOf(shared), a.name])].join(",") });
          toast(`${a.name} can use ${s.name}`, "", "success");
        } else {
          if (list.length) {
            const rest = list.filter((x) => x !== a.name);
            if (rest.length) await run1(["secret", "set", s.name], { agents: rest.join(",") });
            else { for (const sl of shared) await run1(["secret", "unshare", s.name], { p: sl }); await run1(["secret", "set", s.name], { agents: "" }); }
          } else if (!others) await run1(["secret", "unshare", s.name], { p: p.slug });
          else await run1(["secret", "set", s.name], { agents: agentsOf(shared).filter((x) => x !== a.name).join(",") });
          toast(`${a.name} no longer uses ${s.name}`, "", "info");
        }
      } catch (e) { toast("Could not change access", String(e?.message ?? e), "error"); }
      setShared("mp.reloadAt", Date.now());
    });
  }

  // Project tab "Credentials": which tokens / passwords this project's agents may use.
  projectCredsTab(t, p) {
    const list = (this.secrets ?? []).slice().sort((x, y) => x.name.localeCompare(y.name));
    const q = this.agQv?.pcred ?? "";
    const on = list.filter((s) => (s.projects ?? []).includes(p.slug)).length;
    const rows = list.filter((s) => !q || q.split(/\s+/).every((w) => `${s.name} ${typeLabel(s)} ${s.host ?? ""} ${s.url ?? ""} ${s.user ?? ""} ${s.desc ?? ""}`.toLowerCase().includes(w))).map((s) => {
      const has = (s.projects ?? []).includes(p.slug);
      const { prov } = typeOf(s);
      const where = [String(s.host || s.url || "").replace(/^https?:\/\//, ""), s.user].filter(Boolean).join(" · ");
      const only = has && (s.agents ?? []).length ? `only ${s.agents.join(", ")}` : "";
      return h_flex().id(`mp-pc-${s.name}`).flex_none().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center()
        .child(tile(s.name, { size: 16, glyph: prov.glyph, color: prov.color, radius: 4 }))
        .child(div().flex_none().w(260).truncate().text_size(T.text.sm).text_color(has ? t.foreground : t.muted).child(s.name))
        .child(div().flex_none().w(200).truncate().text_size(T.text.xs).text_color(t.dim).child(typeLabel(s)))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(only || where))
        .child(h_flex().flex_none().w(52).justify_center()
          .child(switchEl(t, `mp-pc-sw-${s.name}`, has, (cx) => this.act(cx, ["secret", has ? "unshare" : "share", s.name], { p: p.slug }, has ? `${s.name} removed from ${p.name}` : `${s.name} shared with ${p.name}`))));
    });
    return listPanel(t, { id: "mp-pc", title: "Credentials the agents of this project may use", count: list.length ? `${on} of ${list.length}` : null,
      right: h_flex().gap(T.sp.md).items_center().child(button(t, "mp-pc-add", "Add credential", () => openForm("secret-add", { project: p.slug }), { small: true, ghost: true, iconName: "plus" })),
      search: searchField(t, "mp-pc-q", this.agQ("pcred"), q, () => this.agQClear("pcred")), rows, rowsVisible: 14,
      empty: list.length ? emptyLine(t, "mp-pc-none", "No matches.") : emptyLine(t, "mp-pc-empty", "No credentials yet.", ["Add one", () => openForm("secret-add", { project: p.slug })]) });
  }

  // Recent activity: the agent's last 5 runs; "All runs" opens the project's Activity filtered to it.
  agentRuns(t, p, name) {
    const runs = projectRuns(this, p, name);
    return v_flex().w_full()
      .child(section(t, "Recent activity", { count: runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : null,
        right: runs.length ? h_flex().id("mp-ag-runs-all").gap(T.sp.xs).items_center().cursor_pointer().on_click((_e, cx) => { openProjectActivity(this, p.slug, { agent: name }); cx.notify(); })
          .child(div().text_size(T.text.xs).font_medium().text_color(t.accent).child("All runs")).child(iconEl("chevron-right", t.accent, 11)) : null }))
      .child(card(t, "mp-ag-runs").p(T.sp.xs)
        .when(runs.length === 0, (e) => e.child(emptyLine(t, "mp-ag-runs-empty", "No activity yet.")))
        .children(runList(this, t, p, runs.slice(0, 5), { showAgent: false, idp: "mp-ag-run" })));
  }

  // Agent detail: open tasks (in progress first; 15 unless expanded) and the 5 latest done.
  agentTaskLines(t, mine) {
    const order = ["doing", "review", "blocked", "todo", "backlog"];
    const act = order.flatMap((s) => mine.filter((x) => x.status === s));
    const done = mine.filter((x) => x.status === "done").sort((a, b) => String(b.completed ?? "").localeCompare(String(a.completed ?? ""))).slice(0, 5);
    const lines = (this.adAllTasks ? act : act.slice(0, 15)).map((x) => this.taskLine(t, x));
    if (act.length > 15) lines.push(h_flex().id("mp-ad-tasks-more").h(28).px(8).items_center().rounded(T.r.panel).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.adAllTasks = !this.adAllTasks; cx.notify(); })
      .child(div().text_size(T.text.xs).text_color(t.accent).child(this.adAllTasks ? "Show less" : `Show ${act.length - 15} more open`)));
    return [...lines, ...done.map((x) => this.taskLine(t, x))];
  }
  taskLine(t, x) {
    const [plabel, pcolor] = PRIO[x.priority] ?? PRIO.normal;
    const slug = this.project?.slug;
    return this.navMark(h_flex().id(`mp-tl-${x.id}`).h(32).px(8).gap(8).items_center().rounded(T.r.panel).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => openTaskPanel(slug, x.id))
      .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[x.status]))
      .child(div().flex_none().w(36).text_size(T.text.xs).text_color(t.dim).child(`#${x.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(x.status === "done" ? t.muted : t.foreground).child(x.title))
      .when(x.epic != null && x.epic !== "", (el) => el.child(div().flex_none().max_w(160).truncate().text_size(T.text.xs).text_color(t.dim)
        .child(`↳ #${x.epic} ${this.project?.tasks?.find((z) => String(z.id) === String(x.epic))?.title ?? ""}`)))
      .when(x.priority !== "normal", (el) => el.child(div().text_size(T.text.xs).text_color(pcolor).child(plabel)))
      .child(div().flex_none().w(90).text_size(T.text.xs).text_color(t.muted).child(TASK_EN[x.status])),
    { key: `t:${x.id}`, open: () => openTaskPanel(slug, x.id), ref: { kind: "task", slug, id: x.id } });
  }

  // ------------------------------------------------------------ tasks
  // Unfinished dependencies of a task (byId: Map id -> task, built once per render).
  waitsOf(p, x, byId) {
    if (x.status === "done" || !Array.isArray(x.after) || !x.after.length) return [];
    return x.after.filter((d) => { const y = byId ? byId.get(String(d)) : p.tasks.find((z) => String(z.id) === String(d)); return y && y.status !== "done"; });
  }
  // Compact card (dense board): one line - #id, title, priority mark, agent avatar.
  taskCardSlim(t, p, x, byId) {
    const [plabel, pcolor] = PRIO[x.priority] ?? PRIO.normal;
    const sel = taskPanelOpen(p.slug, x.id);
    const waits = this.waitsOf(p, x, byId);
    return h_flex().id(`mp-card-${x.id}`).min_w(0).h(T.h.row).px(8).gap(6).items_center().rounded(T.r.ctrl).bg(t.surface).border_1()
      .border_color(sel ? t.accent : t.border).cursor_pointer().hover((s) => s.border_color(sel ? t.accent : t.input))
      .tooltip(`#${x.id} ${x.title}${x.agent ? " · " + x.agent : ""}${x.priority !== "normal" ? " · " + plabel : ""}${waits.length ? " · waits for " + waits.map((d) => "#" + d).join(", ") : ""}${x.epic != null ? ` · epic #${x.epic} ${byId?.get(String(x.epic))?.title ?? ""}` : ""}`)
      .on_click(() => openTaskPanel(p.slug, x.id))
      .when(x.priority !== "normal", (el) => el.child(div().flex_none().w(3).h(14).rounded(2).bg(pcolor)))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${x.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(x.status === "done" ? t.muted : t.foreground).child(x.title))
      .when(waits.length > 0, (el) => el.child(iconEl("clock", WARN, 11)))
      .when(x.status === "doing", (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.muted).child(`${x.progress ?? 0}%`)))
      .child(agentAvatar(t, x.agent ?? "?", null, 18));
  }
  // Board card, short and neat: the title on one line (12px), then one meta line —
  // #id · agent avatar · priority dot · machine — and a 2px progress line while in progress.
  taskCard(t, p, x, byId) {
    const [plabel, pcolor] = PRIO[x.priority] ?? PRIO.normal;
    const live = x.agent ? liveAgent(p, x.agent) : null;
    const sel = taskPanelOpen(p.slug, x.id);
    const waits = this.waitsOf(p, x, byId);
    const tip = [`#${x.id} ${x.title}`, x.agent ? x.agent : "Unassigned", x.priority !== "normal" ? plabel : null, x.machine || null,
      waits.length ? `waits for ${waits.map((d) => "#" + d).join(", ")}` : null, x.status === "blocked" && x.blocked_reason ? x.blocked_reason : null].filter(Boolean).join(" · ");
    return v_flex().id(`mp-card-${x.id}`).min_w(0).gap(T.sp.xs).px(T.sp.md).pt(T.sp.sm).pb(x.status === "doing" ? T.sp.xs : T.sp.sm).rounded(T.r.ctrl).bg(t.surface).border_1()
      .border_color(sel ? t.accent : t.border).cursor_pointer().hover((s) => s.border_color(sel ? t.accent : t.input)).on_click(() => openTaskPanel(p.slug, x.id))
      .tooltip(tip)
      // Title: up to two wrapped lines (cut with "…" after the second), never a one-line truncation.
      .child(div().min_w(0).max_h(2 * T.lh.sm).overflow_hidden().whitespace_normal().text_size(T.text.sm).line_height(`${T.lh.sm}px`)
        .text_color(x.status === "done" ? t.muted : t.foreground).child(clamp2(x.title, Math.floor(((this.boardColW ?? 220) - 2 * T.sp.md - 2) / (T.text.sm * 0.6)))))
      // Task of an epic: one dim line "↳ #N epic title".
      .when(x.epic != null && x.epic !== "", (el) => el.child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim)
        .child(`↳ #${x.epic} ${byId?.get(String(x.epic))?.title ?? ""}`)))
      .child(h_flex().min_w(0).h(18).gap(T.sp.sm).items_center()
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${x.id}`))
        .child(agentAvatar(t, x.agent ?? "?", live, 18))
        .when(x.priority !== "normal", (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(pcolor)))
        .when(waits.length > 0, (el) => el.child(iconEl("clock", WARN, 10)))
        .when(x.status === "blocked", (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(BAD)))
        .when(Boolean(x.machine), (el) => el.child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(x.machine)))
        .child(div().flex_1())
        .when(x.status === "doing", (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.muted).child(`${x.progress ?? 0}%`)))
        .when(x.status === "done", (el) => el.child(relTime(t, `mp-card-ts-${x.id}`, x.completed ?? x.created))))
      .when(x.status === "doing", (el) => el.child(div().pt(T.sp.xs).child(meter(t, x.progress ?? 0, null, 2))));
  }

  // Tasks scale to hundreds: filters (agent, search, quick) narrow the list; columns and lanes show
  // a capped number of cards with "Show more"; the board turns compact (one line per card) when busy.
  // Search fields of the list panels (kit.js listPanel): created once, outside render.
  agQ(key) {
    this.agQs ??= {}; this.agQv ??= {};
    if (!this.agQs[key]) {
      const st = InputState.new({ placeholder: "Search" });
      st.on("change", (_e, cx) => { this.agQv[key] = st.value().trim().toLowerCase(); cx.notify(); });
      this.agQs[key] = st;
    }
    return this.agQs[key];
  }
  agQClear(key) { this.agQs?.[key]?.set_value(""); if (this.agQv) this.agQv[key] = ""; }
  // Tokens & Access search (secrets.js).
  secSearchState() {
    if (!this.secSearch) {
      this.secSearch = InputState.new({ placeholder: "Search tokens, passwords, hosts, projects" });
      this.secSearch.on("change", (_e, cx) => { this.secQ = this.secSearch.value().trim().toLowerCase(); cx.notify(); });
    }
    return this.secSearch;
  }
  taskSearchState() {
    if (!this.taskSearch) {
      this.taskSearch = InputState.new({ placeholder: "Search tasks or #id" });
      this.taskSearch.on("change", (_e, cx) => { this.taskQ = this.taskSearch.value().trim().toLowerCase(); this.colShow = {}; cx.notify(); });
    }
    return this.taskSearch;
  }
  // Agent filter for big teams (> 6 agents): one dropdown with a search field and open-task counts.
  agentDropdown(t, names, openOf) {
    const open = this.agentMenu === true;
    const q = this.agentPickQ ?? "";
    const total = [...openOf.values()].reduce((a, b) => a + b, 0);
    const shown = [...names].filter((n) => !q || n.toLowerCase().includes(q)).sort((a, b) => (openOf.get(b) ?? 0) - (openOf.get(a) ?? 0) || a.localeCompare(b));
    const pick = (n) => (_e, cx) => { this.taskFilter = n; this.agentMenu = false; this.colShow = {}; restoreFocus("agent-filter"); cx.notify(); };
    const item = (key, label, n, on, go, lead) => h_flex().id(`mp-tfd-${key}`).flex_none().h(T.h.rowDense).mx(T.sp.xs).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
      .text_size(T.text.sm).hover((s) => s.bg(t.hover)).on_click(go)
      .child(lead ?? div().w(0)).child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(String(n)))
      .child(on ? iconEl("check", t.accent, 12) : div().w(12));
    return Popover.new("mp-tfd").anchor("top_left").open(open)
      .on_open_change((o, cx) => { this.agentMenu = o; popFocus(o, "agent-filter"); if (o) cx.spawn(async () => this.agentPickState().focus()); cx.notify(); })
      .trigger(h_flex().id("mp-tfd-t").flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
        .bg(this.taskFilter ? t.selected : t.raised).border_1().border_color(open || this.taskFilter ? t.accent : t.border).text_size(T.text.sm)
        .child(div().text_color(t.dim).child("Agent"))
        .child(div().max_w(150).truncate().text_color(this.taskFilter ? t.foreground : t.muted).child(this.taskFilter ?? "All"))
        .when(Boolean(this.taskFilter), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(String(openOf.get(this.taskFilter) ?? 0))))
        .child(iconEl("chevron-down", t.dim, 11)))
      .content(v_flex().w(260).mt(T.sp.xs).rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_md()
        .child(h_flex().h(T.h.input).mx(T.sp.xs).mt(T.sp.xs).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(iconEl("search", t.dim, 12))
          .child(Input.new(this.agentPickState()).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground)))
        .child(v_flex().id("mp-tfd-l").max_h(300).overflow_y_scroll().py(T.sp.xs)
          .when(!q, (el) => el.child(item("all", "All agents", total, !this.taskFilter, pick(null))))
          .when(shown.length === 0, (el) => el.child(div().px(T.sp.lg).py(T.sp.md).text_size(T.text.sm).text_color(t.dim).child("No agent matches.")))
          .children(shown.map((n) => item(n, n, openOf.get(n) ?? 0, this.taskFilter === n, pick(this.taskFilter === n ? null : n), agentAvatar(t, n, liveAgent(this.project, n), 14))))));
  }
  // Epics (project sub-view "Epics", Alt+4): one row per epic — green bar, EPIC, #id title, lead, plan state,
  // progress n/m, updated. Click / Enter opens the epic in the task panel; the chevron or → lists its tasks
  // (← folds them). Epics never sit in a board column (their status follows their tasks).
  epicsTab(t, p) {
    const all = p.tasks.filter(isEpic);
    const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
    const open = all.filter((e) => e.status !== "done").sort((a, b) => (PRI[a.priority] ?? 2) - (PRI[b.priority] ?? 2) || Number(a.id) - Number(b.id));
    const done = all.filter((e) => e.status === "done").sort((a, b) => String(b.completed ?? "").localeCompare(String(a.completed ?? "")));
    const showDone = Boolean(this.epicsShowDone);
    this.epicOpen ??= {};
    // Design previews (dev bridge): shared "mp.devEpicOpen" = { id, at } expands that epic once.
    const dev = shared("mp.devEpicOpen");
    if (dev?.at && dev.at !== this.devEpicAt) { this.devEpicAt = dev.at; this.epicOpen[dev.id] = true; }
    const ORDER = { doing: 0, review: 1, blocked: 2, todo: 3, backlog: 4, done: 5 };
    const w = Math.floor(this.width ?? 900) - 2 * T.sp.xxl;
    const showWhen = w >= 640, showLeadName = w >= 560;
    const newEpic = () => openForm("task-add", { project: p.slug, asEpic: true });
    // Plan state in plain words: needs plan / awaiting approval / revise / in progress / done.
    const planOf = (e, kids) => {
      if (e.status === "done") return ["Done", OK];
      if (!kids.length) return ["Needs plan", t.muted];
      if (e.plan === "pending") return ["Awaiting approval", WARN];
      if (e.plan === "revise") return ["Revise plan", BAD];
      if (kids.some((k) => k.status !== "backlog" && k.status !== "todo")) return ["In progress", TASK_COLOR.doing];
      return ["Planned", TASK_COLOR.todo];
    };
    const latest = (e, kids) => [e, ...kids].flatMap((x) => [x.completed, x.started, x.created]).filter(Boolean).sort().pop() ?? null;
    const head = h_flex().h(T.h.rowDense).pl(T.sp.xxl + T.sp.lg + 3).pr(T.sp.md).gap(T.sp.md).items_center().border_b_1().border_color(t.border)
      .text_size(T.text.xs).text_color(t.dim)
      .child(div().flex_1().min_w(0).child("Epic"))
      .child(div().flex_none().w(showLeadName ? 140 : 24).child("Lead"))
      .child(div().flex_none().w(132).child("Plan"))
      .child(div().flex_none().w(120).child("Progress"))
      .when(showWhen, (el) => el.child(div().flex_none().w(56).child("Updated")));
    const row = (e) => {
      const kids = epicKids(p, e);
      const n = kids.length, d = kids.filter((k) => k.status === "done").length;
      const [label, lc] = planOf(e, kids);
      const isOpen = Boolean(this.epicOpen[e.id]);
      const toggle = (v) => (cx) => { this.epicOpen[e.id] = v ?? !this.epicOpen[e.id]; cx?.notify?.(); };
      const when = latest(e, kids);
      const line = this.navMark(h_flex().id(`mp-epic-${e.id}`).h(T.h.rowTall).pr(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
        .bg(taskPanelOpen(p.slug, e.id) ? t.selected : clear).hover((s) => s.bg(t.hover))
        .on_click(() => openTaskPanel(p.slug, e.id)).tooltip(`Epic #${e.id} ${e.title} · lead ${e.agent ?? "—"} · ${d}/${n} done`)
        .child(h_flex().id(`mp-epic-x-${e.id}`).flex_none().size(20).items_center().justify_center().rounded(T.r.chip).hover((s) => s.bg(t.raised))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); toggle()(cx); })
          .tooltip(isOpen ? "Hide its tasks (←)" : "Show its tasks (→)")
          .child(iconEl(isOpen ? "chevron-down" : "chevron-right", t.dim, 11)))
        .child(div().flex_none().w(3).h(20).rounded(2).bg(OK))
        .child(div().flex_none().text_size(T.text.xs).font_medium().text_color(OK).child("EPIC"))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${e.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(e.status === "done" ? t.muted : t.foreground).child(e.title))
        .child(h_flex().flex_none().w(showLeadName ? 140 : 24).gap(T.sp.sm).items_center()
          .child(agentAvatar(t, e.agent ?? "?", e.agent ? liveAgent(p, e.agent) : null, 18))
          .when(showLeadName, (el) => el.child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(e.agent ?? "Unassigned"))))
        .child(h_flex().flex_none().w(132).gap(T.sp.sm).items_center()
          .child(div().flex_none().size(T.dot).rounded_full().bg(lc))
          .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(lc === t.muted ? t.muted : lc).child(label)))
        .child(h_flex().flex_none().w(120).gap(T.sp.sm).items_center()
          .child(div().flex_1().child(meter(t, n ? (100 * d) / n : 0, OK, 3)))
          .child(div().flex_none().w(36).text_size(T.text.xs).text_color(t.muted).child(`${d}/${n}`)))
        .when(showWhen, (el) => el.child(div().flex_none().w(56).child(relTime(t, `mp-epic-ts-${e.id}`, when)))),
      { key: `ep:${e.id}`, open: () => openTaskPanel(p.slug, e.id), ref: { kind: "task", slug: p.slug, id: e.id },
        keys: { right: toggle(true), l: toggle(true), left: toggle(false), h: toggle(false) } });
      if (!isOpen) return line;
      const sorted = [...kids].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || Number(a.id) - Number(b.id));
      return v_flex().child(line).child(v_flex().pl(T.sp.xxl + T.sp.lg + 3).pr(T.sp.md).pb(T.sp.sm)
        .when(!sorted.length, (el) => el.child(h_flex().h(T.h.rowDense).px(T.sp.sm).items_center().text_size(T.text.xs).text_color(t.dim)
          .child(`No tasks yet: ${e.agent ?? "the lead"} plans them (hp epic plan ${e.id}).`)))
        .children(sorted.map((k) => this.navMark(h_flex().id(`mp-ek-${k.id}`).h(T.h.row).px(T.sp.sm).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => openTaskPanel(p.slug, k.id))
          .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[k.status] ?? t.dim))
          .child(div().flex_none().w(36).text_size(T.text.xs).text_color(t.dim).child(`#${k.id}`))
          .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(k.status === "done" ? t.muted : t.foreground).child(k.title))
          .child(div().flex_none().w(84).text_size(T.text.xs).text_color(t.muted).child(TASK_EN[k.status] ?? k.status))
          .child(agentAvatar(t, k.agent ?? "?", k.agent ? liveAgent(p, k.agent) : null, 18)),
        { key: `t:${k.id}`, open: () => openTaskPanel(p.slug, k.id), ref: { kind: "task", slug: p.slug, id: k.id } })))
        .child(h_flex().id(`mp-ek-add-${e.id}`).h(T.h.rowDense).px(T.sp.sm).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => openForm("task-add", { project: p.slug, epic: e.id }))
          .child(iconEl("plus", t.dim, 11)).child(div().text_size(T.text.xs).text_color(t.muted).child("Add task"))));
    };
    const list = [...open, ...(showDone ? done : [])];
    return v_flex().gap(12)
      .child(h_flex().gap(T.sp.md).items_center()
        .child(div().text_size(T.text.xs).text_color(t.muted).child(`${open.length} open${done.length ? ` · ${done.length} done` : ""}`))
        .child(div().flex_1())
        .when(done.length > 0, (el) => el.child(button(t, "mp-epics-done", showDone ? "Hide done" : `Show done (${done.length})`, (_e, cx) => { this.epicsShowDone = !showDone; cx?.notify?.(); }, { small: true, ghost: true })))
        .child(button(t, "mp-epics-add", "New Epic", newEpic, { small: true, primary: true, iconName: "plus" })))
      .child(card(t, "mp-epics").p(T.sp.xs)
        .when(!list.length, (el) => el.child(emptyLine(t, "mp-epics-empty", all.length ? "All epics are done." : "No epics yet.", all.length ? null : ["New epic", newEpic])))
        .when(list.length > 0, (el) => el.child(head))
        .children(list.map(row)));
  }
  // Tasks: one quiet line pointing to the Epics view ("3 epics in progress →").
  epicHint(t, p) {
    const open = p.tasks.filter((x) => isEpic(x) && x.status !== "done").length;
    if (!open) return null;
    return h_flex().id("mp-epics-hint").flex_none().gap(T.sp.sm).items_center().cursor_pointer().text_size(T.text.xs).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground)).tooltip("Open the Epics view (Alt+4)")
      .on_click(() => setShared("mp.view", { kind: "project", slug: p.slug, tab: "epics" }))
      .child(div().flex_none().w(3).h(12).rounded(2).bg(OK))
      .child(`${open} epic${open === 1 ? "" : "s"} in progress`).child(iconEl("chevron-right", t.dim, 10));
  }
  tasksTab(t, p) {
    this.agentPickState();
    // Filters (agent, quick, search, view, compact) are kept per project in shared("mp.taskFilters") and
    // restored when you come back to the project's Tasks.
    if (this.taskFor !== p.slug) {
      this.taskFor = p.slug; this.colShow = {}; this.laneOpen = {};
      const f = (shared("mp.taskFilters") ?? {})[p.slug] ?? {};
      this.taskQuick = f.quick ?? null; this.taskQ = String(f.q ?? "").trim().toLowerCase(); this.taskSearch?.set_value(f.q ?? "");
      if (f.agent !== undefined) this.taskFilter = f.agent;
      if (f.mode) this.taskMode = f.mode;
      this.taskDense = f.dense ?? undefined;
    }
    {
      const tf = { agent: this.taskFilter ?? null, quick: this.taskQuick ?? null, q: this.taskSearch?.value?.() ?? "", mode: this.taskMode, dense: this.taskDense ?? null };
      const js = JSON.stringify(tf), slug = p.slug;
      if (js !== this.tfSaved?.[slug]) { (this.tfSaved ??= {})[slug] = js; Promise.resolve().then(() => setShared("mp.taskFilters", { ...(shared("mp.taskFilters") ?? {}), [slug]: tf })); }
    }
    this.colShow ??= {}; this.laneOpen ??= {};
    const byId = new Map(p.tasks.map((x) => [String(x.id), x]));
    const openOf = new Map(); // agent -> open task count (chips and lane order)
    for (const x of p.tasks) if (x.agent && x.status !== "done" && !isEpic(x)) openOf.set(x.agent, (openOf.get(x.agent) ?? 0) + 1);
    const names = [...new Set([...p.agents.map((a) => a.name), ...p.tasks.map((x) => x.agent).filter(Boolean)])];
    // Filters: agent chip, quick filter, text search (#12 or 12 finds the task by id).
    const q = this.taskQ ?? "";
    const qId = /^#?\d+$/.test(q) ? q.replace("#", "") : null;
    const QUICK = {
      blocked: ["Blocked", BAD, (x) => x.status === "blocked"],
      waiting: ["Waiting", WARN, (x) => this.waitsOf(p, x, byId).length > 0],
      urgent: ["High+", WARN, (x) => x.status !== "done" && (x.priority === "urgent" || x.priority === "high")],
    };
    const quick = QUICK[this.taskQuick]?.[2];
    const list = p.tasks.filter((x) => (!this.taskFilter || x.agent === this.taskFilter) && (!quick || quick(x))
      && (!q || (qId ? String(x.id) === qId : `${x.title} ${x.desc ?? ""} ${x.agent ?? ""}`.toLowerCase().includes(q))));
    const filtered = list.length !== p.tasks.length;
    // Epics live in their own view (Epics); here only a one-line hint. Columns and lanes hold the tasks.
    const epicsEl = this.epicHint(t, p);
    const cardList = list.filter((x) => !isEpic(x));
    const chip = (id, label, on, onClick, color) => h_flex().id(id).flex_none().h(T.h.btnSm).px(T.sp.md).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.sm)
      .bg(on ? t.selected : t.raised).border_1().border_color(on ? (color ?? t.accent) : t.border)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); this.colShow = {}; cx.notify(); }).child(label);
    const count = (n) => div().text_size(T.text.xs).text_color(t.dim).child(String(n));
    // Board density: auto (compact past 60 tasks in view), or forced by the toggle.
    const dense = this.taskDense ?? false; // the board card is already compact; the toggle gives one-line cards
    // Two rows: view + search + quick filters + actions on top, the agent filter (scrolls) below,
    // so agent chips are never clipped behind the buttons.
    const toolbarTop = h_flex().gap(8).items_center().flex_wrap() // wraps instead of clipping the quick filters in a narrow view
      .child(h_flex().flex_none().p(2).gap(2).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border).children([["kanban", "Board"], ["agents", "By agent"]].map(([k, l]) =>
        h_flex().id(`mp-tm-${k}`).h(22).px(T.sp.md).rounded(T.r.chip).items_center().cursor_pointer().text_size(T.text.sm).font_medium()
          .bg(this.taskMode === k ? t.surface : clear).text_color(this.taskMode === k ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.taskMode = k; cx.notify(); }).child(l))))
      .child(h_flex().id("mp-tq").flex_none().w(220).h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).bg(t.raised).border_1().border_color(q ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(iconEl("search", t.dim, 13))
        .child(Input.new(this.taskSearchState()).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground))
        .when(!q, (el) => el.child(kbd(t, "/")))
        .when(Boolean(q), (el) => el.child(iconButton(t, "mp-tq-x", "x", (_e, cx) => { this.taskSearch.set_value(""); this.taskQ = ""; cx.notify(); }, "Clear", { size: 20 }))))
      .children(Object.entries(QUICK).map(([k, [label, color, fn]]) => {
        const n = p.tasks.filter(fn).length;
        return chip(`mp-tqk-${k}`, h_flex().gap(6).items_center().child(div().size(6).rounded_full().bg(color)).child(label).child(count(n)),
          this.taskQuick === k, () => { this.taskQuick = this.taskQuick === k ? null : k; }, color);
      }))
      .when(names.length > 6, (el) => el.child(this.agentDropdown(t, names, openOf)))
      .child(div().flex_1())
      .when(this.taskMode !== "agents", (el) => el.child(iconButton(t, "mp-t-dense", dense ? "maximize" : "minimize", (_e, cx) => { this.taskDense = !dense; cx.notify(); },
        dense ? "Show full cards" : "Compact cards (title only)", { filled: true })))
      .child(button(t, "mp-t-add", "New Task", () => openForm("task-add", { project: p.slug }), { small: true, primary: true, iconName: "plus" }));
    const toolbar = v_flex().gap(8).child(toolbarTop)
      .when(names.length > 0 && names.length <= 6, (el) => el.child(h_flex().id("mp-tf").min_w(0).gap(6).items_center().overflow_x_scroll()
        .child(div().flex_none().w(44).text_size(T.text.xs).text_color(t.dim).child("Agent"))
        .child(chip("mp-tf-all", "All", !this.taskFilter, () => { this.taskFilter = null; }))
        .children([...names].sort((a, b) => (openOf.get(b) ?? 0) - (openOf.get(a) ?? 0)).map((n) =>
          chip(`mp-tf-${n}`, h_flex().gap(6).items_center().child(n).child(count(openOf.get(n) ?? 0)), this.taskFilter === n, () => { this.taskFilter = this.taskFilter === n ? null : n; })))));
    const more = (id, label, onClick) => h_flex().id(id).h(28).px(8).items_center().justify_center().rounded(T.r.panel).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); }).child(div().text_size(T.text.xs).text_color(t.accent).child(label));
    const note = filtered ? div().text_size(T.text.xs).text_color(t.muted).child(`${list.length} of ${p.tasks.length} tasks match`) : null;
    const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
    const byPrio = (a, b) => (PRI[a.priority] ?? 2) - (PRI[b.priority] ?? 2) || Number(a.id) - Number(b.id);
    const byDone = (a, b) => String(b.completed ?? "").localeCompare(String(a.completed ?? ""));

    // By agent: a swimlane kanban. Column headers on top (To Do · In Progress · Review · Blocked · Done), one lane
    // per agent (most open tasks first, collapsible): the agent on the left, its tasks as small cards in the
    // status columns. Backlog sits in To Do (dimmed); Done shows the latest few. 4 cards per cell, then "+N".
    if (this.taskMode === "agents") {
      const LCOLS = ["todo", "doing", "review", "blocked", "done"];
      const groups = new Map();
      for (const x of cardList) { const k = x.agent ?? ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
      const shown = (this.taskFilter ? [this.taskFilter] : names).filter((n) => !filtered || groups.has(n))
        .sort((a, b) => (openOf.get(b) ?? 0) - (openOf.get(a) ?? 0));
      const GAP = T.sp.md, LANE_W = 190, CELL_CAP = 4;
      const avail = Math.max(480, Math.floor(this.width) - 2 * T.sp.xxl - 2);
      const cellW = Math.max(150, Math.floor((avail - LANE_W - GAP * LCOLS.length - 2 * 12) / LCOLS.length));
      const cellOf = (x) => (x.status === "backlog" ? "todo" : LCOLS.includes(x.status) ? x.status : "todo");
      const laneCard = (x) => {
        const [, pcolor] = PRIO[x.priority] ?? PRIO.normal;
        const sel = taskPanelOpen(p.slug, x.id);
        const waits = this.waitsOf(p, x, byId);
        return v_flex().id(`mp-lc-${x.id}`).w_full().min_w(0).px(8).py(6).gap(4).rounded(T.r.ctrl).bg(t.background).border_1()
          .border_color(sel ? t.accent : t.border).cursor_pointer().hover((st) => st.border_color(sel ? t.accent : t.input))
          .when(x.status === "backlog" || x.status === "done", (el) => el.opacity(0.7))
          .tooltip(`#${x.id} ${x.title}${waits.length ? " · waits for " + waits.map((d) => "#" + d).join(", ") : ""}${x.status === "blocked" && x.blocked_reason ? " · " + x.blocked_reason : ""}`)
          .on_click(() => openTaskPanel(p.slug, x.id))
          .child(div().w_full().min_w(0).text_size(T.text.sm).line_height(`${T.lh.sm}px`).h(T.lh.sm * 2).overflow_hidden().whitespace_normal()
            .text_color(x.status === "done" ? t.muted : t.foreground).child(x.title))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${x.id}`))
            .when(x.priority === "urgent" || x.priority === "high", (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(pcolor)))
            .when(x.status === "backlog", (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("backlog")))
            .when(waits.length > 0, (el) => el.child(iconEl("clock", WARN, 11)))
            .child(div().flex_1())
            .when(x.status === "doing", (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.muted).child(`${x.progress ?? 0}%`))))
          .when(x.status === "doing", (el) => el.child(div().h(3).w_full().rounded_full().bg(t.hover).overflow_hidden()
            .child(div().h_full().w(`${Math.max(0, Math.min(100, x.progress ?? 0))}%`).rounded_full().bg(TASK_COLOR.doing))));
      };
      const header = h_flex().gap(GAP).px(12).items_center()
        .child(div().flex_none().w(LANE_W).text_size(T.text.xs).text_color(t.dim).child(`${shown.length} agent${shown.length === 1 ? "" : "s"}`))
        .children(LCOLS.map((s) => h_flex().flex_none().w(cellW).h(T.h.rowDense).gap(T.sp.sm).items_center().border_b_1().border_color(t.border)
          .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[s]))
          .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(s === "todo" ? "To Do" : TASK_EN[s]))
          .child(div().text_size(T.text.xs).text_color(t.dim).child(String(cardList.filter((x) => cellOf(x) === s).length)))));
      const lane = (n) => {
        const mine = groups.get(n) ?? [];
        const live = liveAgent(p, n);
        const isOpen = this.laneOpen[n] ?? true;
        const cells = Object.fromEntries(LCOLS.map((s) => [s, []]));
        for (const x of mine) cells[cellOf(x)].push(x);
        for (const s of LCOLS) cells[s].sort(s === "done" ? byDone : (a, b) => (a.status === "backlog") - (b.status === "backlog") || byPrio(a, b));
        const openN = openOf.get(n) ?? 0, doneN = cells.done.length;
        return v_flex().id(`mp-tlane-${n}`).w_full().rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border)
          .child(h_flex().w_full().px(12).py(10).gap(GAP).items_start()
            // Lane label: avatar, name, live status, counts; click folds the lane.
            .child(h_flex().id(`mp-tlane-h-${n}`).flex_none().w(LANE_W).gap(10).items_center().cursor_pointer()
              .on_click((_e, cx) => { this.laneOpen[n] = !isOpen; cx.notify(); })
              .child(iconEl(isOpen ? "chevron-down" : "chevron-right", t.dim, 12))
              .child(agentAvatar(t, n, live, 26))
              .child(v_flex().flex_1().min_w(0)
                .child(div().text_size(T.text.sm).font_semibold().truncate().child(n))
                .child(div().text_size(T.text.xs).text_color(live ? statusColor(t, live.status) : t.dim).truncate().child(live ? STATUS_EN[live.status] ?? live.status : "Stopped"))
                .child(div().text_size(T.text.xs).text_color(t.dim).child(`${openN} open · ${doneN} done`))))
            .children(LCOLS.map((s) => {
              const items = cells[s];
              const key = `lane-${n}-${s}`;
              const cap = this.colShow[key] ?? CELL_CAP;
              return v_flex().flex_none().w(cellW).min_w(0).gap(6)
                .when(!isOpen, (el) => el.child(div().h(T.h.rowDense).text_size(T.text.xs).text_color(items.length ? t.muted : t.dim).child(items.length ? String(items.length) : "—")))
                .when(isOpen && !items.length, (el) => el.child(div().h(T.h.rowDense).text_size(T.text.xs).text_color(t.dim).child("—")))
                .when(isOpen, (el) => el.children(items.slice(0, cap).map((x) => this.navMark(laneCard(x), { key: `t:${x.id}`, open: () => openTaskPanel(p.slug, x.id), ref: { kind: "task", slug: p.slug, id: x.id } }, true))))
                .when(isOpen && items.length > cap, (el) => el.child(more(`mp-lm-${n}-${s}`, `+${items.length - cap} more`, () => { this.colShow[key] = cap + 20; })));
            })));
      };
      return v_flex().gap(8).child(toolbar).when(Boolean(note), (el) => el.child(note))
        .when(Boolean(epicsEl), (el) => el.child(epicsEl))
        .when(shown.length === 0, (el) => el.child(empty(t, "No tasks match.")))
        .when(shown.length > 0, (el) => el.child(header).children(shown.map(lane)));
    }
    // Board: six columns in one row when each gets >= 200 px, else two rows of three (Backlog · To Do ·
    // In Progress, then Review · Blocked · Done). Equal widths fill the view: no sideways scroll, nothing
    // folded; titles wrap to two lines. 6 cards per column, then "+N more".
    const cols = Object.fromEntries(COLS.map((s) => [s, []]));
    for (const x of cardList) (cols[x.status] ?? cols.todo).push(x);
    const card_ = (x) => (dense ? this.taskCardSlim(t, p, x, byId) : this.taskCard(t, p, x, byId));
    const colHead = (s, total) => h_flex().h(T.h.rowDense).px(T.sp.xs).gap(T.sp.sm).items_center().border_b_1().border_color(t.border)
      .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[s]))
      .child(div().flex_none().text_size(T.text.xs).font_medium().text_color(t.muted).child(TASK_EN[s]))
      .child(div().flex_1().text_size(T.text.xs).text_color(t.dim).child(String(total)));
    // Widths come from the view's own measured width (minus its 24 px gutters), never from the board's size.
    const GAP = T.sp.md, MIN = 200;
    const avail = Math.max(320, Math.floor(this.width) - 2 * T.sp.xxl - 2);
    const perRow = (avail - GAP * (COLS.length - 1)) / COLS.length >= MIN ? COLS.length : 3;
    const colW = Math.floor((avail - GAP * (perRow - 1)) / perRow);
    this.boardColW = colW; // card titles wrap to the width they get (taskCard)
    const column = (s, ci) => {
      const items = cols[s].sort(s === "done" ? byDone : byPrio);
      const total = items.length;
      const cap = this.colShow[s] ?? COL_SHOW;
      const shown = items.slice(0, cap);
      return v_flex().id(`mp-col-${s}`).flex_none().w(colW).min_w(0).gap(dense ? 4 : 6)
        .child(colHead(s, total))
        .when(total === 0, (el) => el.child(div().h(T.h.row).px(T.sp.xs).pt(T.sp.sm).text_size(T.text.xs).text_color(t.dim).child(filtered ? "No matches" : "—")))
        .children(shown.map((x) => this.navMark(card_(x), { key: `t:${x.id}`, col: ci, open: () => openTaskPanel(p.slug, x.id), ref: { kind: "task", slug: p.slug, id: x.id } }, true)))
        .when(total > cap, (el) => el.child(more(`mp-col-more-${s}`, `+${total - cap} more`, () => { this.colShow[s] = cap + 30; })))
        .when(cap > COL_SHOW && total > COL_SHOW, (el) => el.child(more(`mp-col-less-${s}`, "Show less", () => { delete this.colShow[s]; })));
    };
    const rows = perRow === COLS.length ? [COLS] : [COLS.slice(0, 3), COLS.slice(3)];
    return v_flex().gap(12).child(toolbar).when(Boolean(note), (el) => el.child(note))
      .when(Boolean(epicsEl), (el) => el.child(epicsEl))
      .child(v_flex().id("mp-kanban").w(avail).max_w_full().min_w(0).gap(T.sp.xl).pb(T.sp.xs)
        .children(rows.map((r, ri) => h_flex().id(`mp-kanban-r${ri}`).w_full().min_w(0).gap(GAP).items_start()
          .children(r.map((s) => column(s, COLS.indexOf(s)))))));
  }

  // ------------------------------------------------------------ project settings
  settingsTab(t, p) {
    return v_flex().gap(16)
      .child(card(t, "mp-ps-main").child(cardHeader(t, "Project", button(t, "mp-ps-edit", "Edit", () => openForm("project-edit", { project: p.slug, name: p.name, desc: p.desc ?? "" }), { small: true })))
        .child(v_flex().px(12).pb(12).child(this.metaRow(t, "Name", p.name)).child(this.metaRow(t, "ID", p.slug)).child(this.metaRow(t, "Folder", p.dir))
          .child(this.metaRow(t, "Description", p.desc || "—"))))
      .child(card(t, "mp-ps-danger").child(cardHeader(t, "Delete project", this.confirmButton(t, "mp-ps-rm", "Delete Project", (_e, cx) => {
          cx.spawn(async (cx) => {
            const r = await hp(["project", "rm"], { p: p.slug, confirm: p.slug });
            if (!r.ok) { toast("Could not delete project", r.err, "error"); return; }
            const sp = projectSpace(p);
            if (sp) run("space.close", { id: sp.id, confirmed: true });
            const rest = (await listProjects()).filter((x) => x.slug !== p.slug);
            selectProject(rest[0]?.slug ?? null, "overview");
            toast(`Deleted ${p.name}`, "Moved to ~/.herdr/trash — you can restore it from there.", "success");
          });
        }, { small: true, iconName: "x" }).tooltip("Stops its agents and moves the project to ~/.herdr/trash. Machines and secrets stay."))))
      .child(card(t, "mp-ps-agents").child(cardHeader(t, "Agent instructions", button(t, "mp-ps-docs", "Regenerate AGENTS.md", (_e, cx) => this.act(cx, ["project", "docs"], { p: p.slug }, "AGENTS.md regenerated"), { small: true })))
        .child(v_flex().px(12).pb(12).child(this.metaRow(t, "File", `${p.dir}/AGENTS.md`)).child(this.metaRow(t, "Claude Code", "CLAUDE.md imports AGENTS.md"))));
  }
}
