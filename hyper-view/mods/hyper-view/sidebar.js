// Sidebar, IDE style: a 48 px activity bar (always visible, also when the explorer is collapsed) and an
// explorer next to it showing the section of the current mode: Projects (→ Overview / Agents → agent / Tasks /
// Machines / Activity), Machines (→ Overview / Editor / Access) or Agents (every agent, grouped under
// project headers, loose ones in a "Loose agents" group last). Type-to-filter on top; a footer warning only when a
// usage limit is low or a login is needed (the limits themselves are in the status bar).
// The activity bar switches modes (toolbar.js MODES): each mode shows or hides the explorer and the chat
// column; clicking the lit icon again toggles the explorer (VS Code).
// Patterns: VS Code activity bar + explorer (selected icon = accent bar on the left edge; Ctrl+Shift+E),
// Zed / JetBrains project panel (dense 24 px rows, indent guides, speed search), Linear sidebar (counts dim,
// status = dot), WAI-ARIA APG tree view keyboard: ↑↓ move, → opens a closed node / goes to the first child,
// ← closes an open node / goes to the parent, Home/End, * expands siblings, type-ahead on letters.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, shared, setShared, run, settings, keys } from "herdr";
import {
  listProjects, loadProject, loadMachines, watchData, view, selectProject, openVm, openProjectSpace, showCenter,
  liveAgent, loginProvider, vmStats, vmHealth, tile, iconEl, pct, clear, OK, WARN, BAD, INFO, colorFor, tourSizes,
  measure, scrollY, hp, claimJob, repeat, setSharedIf, loadLocks, lockOf, lockTip, openDashboard, openPalette, isWaiting, pumpFocus, leadOf,
} from "./lib.js";
import { openForm } from "./form.js";
import { loadMailbox, publishCount } from "./mailbox.js";
import { LEFT, isCollapsed, MODES, modeOf, applyMode, userToggleLeft, setChat, chatState, wantedLayout, openAgentPage } from "./toolbar.js";

const LIMITS_EVERY = 3 * 60 * 1000;
const winLabel = (m) => (m === 300 ? "5h" : m === 10080 ? "Week" : m >= 40000 ? "Month" : m ? `${Math.round(m / 60)}h` : "");
function left(w) {
  if (!w) return null;
  const reset = w.resets_at ? new Date(w.resets_at).getTime() : 0;
  if (reset && reset < Date.now()) return { pct: 100, reset: null };
  return { pct: Math.max(0, Math.min(100, 100 - (Number(w.used) || 0))), reset };
}
function until(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
// Claude Code and Codex usage (shared "mp.limits", filled by the sidebar): one entry per provider.
export function limitRows() {
  const L = shared("mp.limits");
  const rows = [];
  const c = L?.claude;
  rows.push({ key: "claude", name: "Claude", color: "#c98a6c", glyph: "zap", err: c && !c.ok ? c.err : !L ? "Checking…" : null,
    wins: c?.ok ? [["5h", left(c.five_hour)], ["Week", left(c.seven_day)]].filter(([, v]) => v) : [] });
  const x = L?.codex;
  rows.push({ key: "codex", name: "Codex", color: "#6aa58f", glyph: "terminal", err: x && !x.ok ? x.err : !L ? "Checking…" : null,
    wins: x?.ok ? [[winLabel(x.primary?.window_minutes) || "Limit", left(x.primary)], [winLabel(x.secondary?.window_minutes) || "Weekly", left(x.secondary)]].filter(([, v]) => v) : [] });
  return rows;
}
export const limitTip = (r) => r.err ?? r.wins.map(([l, v]) => `${l}: ${Math.round(v.pct)}% left${v.reset ? ` · resets in ${until(v.reset)}` : ""}`).join("\n");
export const limitColor = (p, t) => (p < 15 ? BAD : p < 35 ? WARN : t.foreground);
export const refreshLimits = () => setShared("mp.limitsAsk", Date.now());

// Keyboard state lives outside the instance (focus handles and row closures can't be carried over by
// Herdr's in-place reload, which keeps instance fields): one entry per copy, rebuilt lazily.
const KBS = new WeakMap();
const K = (o) => { let s = KBS.get(o); if (!s) KBS.set(o, (s = {})); return s; };

export const RAIL = 48;   // activity bar width
const CELL = 40;          // activity bar cell height
const ROW = 24;           // tree row height
const INDENT = 12;        // per tree level
const SECTIONS = [["projects", "Projects"], ["vms", "Machines"], ["agents", "Agents"]];

// Activity bar: one mode per icon (toolbar.js MODES). Keys: keys.json commands.
export const ACTIVITY = [
  { id: "dash", icon: "activity", label: "Dashboard", cmd: "dashboard" },
  { id: "projects", icon: "layers", label: "Projects", cmd: "focus-sidebar" },
  { id: "vms", icon: "server", label: "Machines", cmd: "explorer-machines" },
  { id: "agents", icon: "bot", label: "Agents", cmd: "explorer-agents" },
  { id: "mailbox", icon: "inbox", label: "Mailbox", cmd: "mailbox" },
  { id: "clipboard", icon: "paperclip", label: "Clipboard", cmd: "clipboard", g: "G C" },
  { id: "tokens", icon: "key", label: "Tokens & Access", cmd: "tokens" },
  { id: "map", icon: "map", label: "Agent map", cmd: "map" },
  { id: "settings", icon: "settings", label: "Settings", cmd: "settings", bottom: true },
];
const keyLabel = (k) => String(k ?? "").split("-").map((p) => ({ ctrl: "Ctrl", shift: "Shift", alt: "Alt", "`": "`" }[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))).join("+");
export function keyOf(cmd) {
  try { return keys().find((b) => (b.section === "layout:hyper-view" || b.section === "global") && b.action === `hyper-view.${cmd}`)?.keys ?? null; } catch { return null; }
}
const sectionOf = (mode) => MODES[mode]?.section ?? "projects";
const modeOfSection = (sec) => ({ projects: "projects", vms: "vms", agents: "agents", loose: "agents" }[sec] ?? "projects");

// Every agent of every project (loose agents too), by name: [{ p, a }].
export const allAgents = (projects) => projects.flatMap((p) => (p.agents ?? []).map((a) => ({ p, a })))
  .sort((x, y) => x.a.name.localeCompare(y.a.name) || String(x.p.name).localeCompare(String(y.p.name)));

// The last view of each mode (shared "mp.modeView"): clicking the mode's icon goes back there.
const modeViews = () => (globalThis.__hvModeView ??= { ...(shared("mp.modeView") ?? {}) });
// Switches to a mode: back to its last view if it still exists, else its first item (Projects: the first
// project's Overview, Machines: the first machine, Agents: the first agent's page).
export async function openMode(mode) {
  const go = (v) => { setShared("mp.view", v); showCenter("mp-view"); };
  const last = modeViews()[mode];
  if (mode === "dash") return go({ kind: "dashboard" });
  if (mode === "mailbox" || mode === "clipboard") return go({ kind: mode });
  if (mode === "tokens") return go({ kind: "secrets" });
  if (mode === "map") return go({ kind: "map" });
  if (mode === "settings") return run("app.settings", {});
  const projects = await listProjects();
  globalThis.__hvLoose = new Set(projects.filter((p) => p.loose).map((p) => p.slug));
  if (mode === "projects") {
    const list = projects.filter((p) => !p.loose);
    if (last?.kind === "project" && list.some((p) => p.slug === last.slug)) { setShared("mp.project", last.slug); return go(last); }
    if (!list.length) return openForm("project-new");
    setShared("mp.project", list[0].slug);
    return go({ kind: "project", slug: list[0].slug, tab: "overview" });
  }
  if (mode === "vms") {
    const ms = await loadMachines();
    const cur = view();
    if (last?.kind === "machines" && ms.length) return go(last);
    if (last?.kind === "vm" && ms.some((m) => m.name === last.name)) return go({ ...last, tab: last.tab === "editor" ? "overview" : last.tab ?? "overview" });
    if (!ms.length) return openForm("vm-add", {});
    return go({ kind: "vm", name: cur.kind === "vm" ? cur.name : ms[0].name, tab: "overview" });
  }
  if (mode === "agents") {
    const all = allAgents(projects);
    const ok = (v) => v?.kind === "project" && all.some(({ p, a }) => p.slug === v.slug && (p.loose || a.name === v.agent));
    if (ok(last)) return go(last);
    if (!all.length) return openForm("loose-agent", {});
    openAgentPage(all[0].p.slug, all[0].a.name, "agents");
    showCenter("mp-view");
  }
}

// Focuses the explorer on a section (switching to its mode when another one is shown).
export function revealSection(sec) {
  setShared("mp.focus", { to: "sidebar", reveal: sec, at: Date.now() });
}

export class Sidebar {
  init(cx) {
    this.projects = [];
    this.machines = [];
    this.detail = {}; // slug -> open task count (expanded projects only)
    this.expanded = new Set(shared("mp.expanded") ?? []);
    this.q = "";
    this.ensureState(cx);
    this.kbSel = null;
    this.actSel = null;
    K(this).kbList = [];
    this.focusAt = shared("mp.focus")?.at;
    globalThis.__hvOaSeen ??= shared("mp.openAgent")?.at ?? 0;
    this.loadLimits(cx);
    repeat(cx, LIMITS_EVERY, (cx) => this.loadLimits(cx), claimJob("sidebar.limits"));
    watchData(cx, (cx) => this.reload(cx), 4000, "sidebar");
  }

  // Inputs, focus handles and the scroll handle (also for copies kept by the in-place reload).
  ensureState(cx) {
    if (!this.filter) {
      this.filter = InputState.new({ placeholder: "Filter" });
      this.filter.on("change", (_e, cx) => { this.q = this.filter.value().trim().toLowerCase(); this.pickFirstMatch(); cx.notify(); });
    }
    const k = K(this);
    try { k.fh ??= cx.focus_handle(); k.fhA ??= cx.focus_handle(); k.scroll ??= ScrollHandle.new(); } catch {}
    if (!globalThis.__hvTreeKeys) {
      // The Input eats ↓ Enter Esc before on_key_down: bindings under our wrapper context win (palette.js pattern).
      try {
        cx.bind_keys([["down", "hv_tree_into"], ["enter", "hv_tree_enter"], ["escape", "hv_tree_esc"]]
          .flatMap(([keystroke, action]) => [{ keystroke, action, context: "HvTreeFilter > Input" }]));
        globalThis.__hvTreeKeys = true;
      } catch (err) { console.warn("sidebar: filter keys", err); }
    }
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      this.projects = await listProjects();
      globalThis.__hvLoose = new Set(this.projects.filter((p) => p.loose).map((p) => p.slug));
      this.machines = await loadMachines();
      await loadLocks().catch(() => {});
      await loadMailbox().then((r) => publishCount(r.open)).catch(() => {});
      for (const p of this.projects) {
        if (p.loose || !(this.expanded ??= new Set()).has(p.slug)) continue;
        const full = await loadProject(p.slug).catch(() => null);
        if (full) (this.detail ??= {})[p.slug] = { tasks: full.tasks.filter((x) => x.status !== "done" && x.kind !== "epic").length, epics: full.tasks.filter((x) => x.status !== "done" && x.kind === "epic").length };
      }
      const v = view();
      // No project open (startup, after a tour or a delete): show the Dashboard.
      if (v.kind === "project" && !v.slug) openDashboard();
      cx.notify();
    });
  }

  // Claude Code and Codex usage limits (hp limits). Stored shared so every copy sees them.
  loadLimits(cx) {
    cx.spawn(async (cx) => {
      const r = await hp(["limits"], {}, 30000);
      try { if (r.ok) setSharedIf("mp.limits", { ...JSON.parse(r.out), checked: Date.now() }, ["checked"]); } catch {}
      cx.notify();
    });
  }

  // ------------------------------------------------------------ tree model
  isOpen(key) { return new Set(shared("mp.treeOpen") ?? []).has(key); }
  toggleOpen(key) {
    const s = new Set(shared("mp.treeOpen") ?? []);
    if (s.has(key)) s.delete(key); else s.add(key);
    setShared("mp.treeOpen", [...s]);
  }
  toggleProject(slug, cx) {
    if (this.expanded.has(slug)) this.expanded.delete(slug); else this.expanded.add(slug);
    setShared("mp.expanded", [...this.expanded]);
    if (cx && this.expanded.has(slug)) this.reload(cx);
  }
  addOf(sec) {
    return { projects: ["New project", () => openForm("project-new")], vms: ["Add machine", () => openForm("vm-add", {})], agents: ["New loose agent", () => openForm("loose-agent", {})] }[sec];
  }

  // The explorer section of the mode: { sec, title, count, rows }; each row
  // { key, level, label, icon, exp (null = leaf), sel, open, toggle, parent, ref, right, sec }.
  build(t, v, sec) {
    const q = this.q;
    const hit = (s) => !q || String(s ?? "").toLowerCase().includes(q);
    const stats = vmStats();
    const tab = v.tab ?? "overview";
    const rows = [];
    let count = 0;
    const dotOf = (la) => (la ? (la.status === "working" ? OK : la.status === "blocked" ? WARN : la.status === "done" ? INFO : "#9aa3ad") : null);
    if (sec === "projects") {
      const list = this.projects.filter((p) => !p.loose);
      count = list.length;
      for (const p of list) {
        const agentHit = q ? p.agents.filter((a) => hit(a.name)) : [];
        if (q && !hit(p.name) && !agentHit.length) continue;
        const key = `p:${p.slug}`;
        const open = this.expanded.has(p.slug) || agentHit.length > 0;
        const here = v.kind === "project" && v.slug === p.slug && v.via !== "agents";
        const live = p.agents.map((a) => liveAgent(p, a.name)).filter(Boolean);
        const working = live.filter((a) => a.status === "working").length;
        const needN = (shared("mp.waiting") ?? []).filter((w) => w.slug === p.slug).length;
        const offline = p.machines.some((n) => stats[n] && !stats[n].ok);
        const openP = (tb) => () => { selectProject(p.slug, tb); openProjectSpace(p); showCenter("mp-view"); };
        rows.push({ key, level: 1, label: p.name, sec, icon: () => tile(p.name, { kind: "project", size: 14, color: p.color, radius: 3 }), exp: open,
          sel: here && !open, open: openP(here && tab !== "agent" ? tab : "overview"), toggle: (cx) => this.toggleProject(p.slug, cx), ref: { kind: "project", slug: p.slug, label: p.name },
          right: needN ? { badge: needN, tip: `${needN} waiting for you · Ctrl+J` } : { dot: offline ? BAD : working ? OK : null, tip: offline ? "A machine is offline" : working ? `${working} working` : "" } });
        if (!open) continue;
        const d = this.detail?.[p.slug];
        const agKey = `${key}/agents`;
        const agOpen = this.isOpen(agKey) || agentHit.length > 0;
        const onAgent = here && tab === "agent";
        const child = (k, label, icon, count, extra = {}) => rows.push({ key: `${key}/${k}`, parent: key, level: 2, label, sec, icon: () => iconEl(icon, t.muted, 13),
          exp: null, sel: here && (tab === k || (k === "machines" && tab === "resources") || (k === "agents" && onAgent && !agOpen)), open: openP(k), right: count != null ? { count } : null, ...extra });
        child("overview", "Overview", "compass");
        child("agents", "Agents", "users", p.agents.length, p.agents.length ? { exp: agOpen, toggle: () => this.toggleOpen(agKey) } : {});
        if (agOpen) for (const a of q && agentHit.length ? agentHit : p.agents) {
          const la = liveAgent(p, a.name);
          rows.push({ key: `a:${p.slug}:${a.name}`, parent: agKey, level: 3, label: a.name, sec, ref: { kind: "agent", slug: p.slug, name: a.name },
            icon: () => this.agentIcon(t, a.name, la), exp: null, sel: onAgent && v.agent === a.name,
            open: () => { openAgentPage(p.slug, a.name, "projects"); showCenter("mp-view"); },
            right: { dot: dotOf(la), lead: a.name === leadOf(p), tip: `${a.name === leadOf(p) ? "Team lead · " : ""}${la?.status ?? "Stopped"}` } });
        }
        child("tasks", "Tasks", "check-square", d?.tasks ?? null);
        child("epics", "Epics", "layers", d?.epics || null);
        child("machines", "Machines", "server", p.machines.length || null);
        child("activity", "Activity", "activity");
      }
    } else if (sec === "vms") {
      count = this.machines.length;
      // The fleet overview (vmview.js machinesOverview) above the machines.
      if (!q && this.machines.length) rows.push({ key: "m:*", level: 1, label: "All machines", sec, exp: null, sel: v.kind === "machines",
        icon: () => iconEl("layout", t.muted, 13), open: () => { setShared("mp.view", { kind: "machines" }); showCenter("mp-view"); } });
      for (const m of this.machines) {
        const st = stats[m.name];
        if (q && !hit(`${m.name} ${m.host} ${m.os ?? ""} ${st?.os ?? ""}`)) continue;
        const key = `m:${m.name}`;
        const open = this.isOpen(key);
        const here = v.kind === "vm" && v.name === m.name;
        const [label, color] = vmHealth(st);
        const lk = lockOf(m.name);
        rows.push({ key, level: 1, label: m.name, sec, exp: open, sel: here && !open, ref: { kind: "machine", name: m.name },
          icon: () => div().relative().flex_none().child(tile(m.name, { kind: "vm", size: 14, radius: 3 }))
            .child(div().absolute().right(-2).bottom(-2).size(T.dot).rounded_full().bg(color).border_1().border_color(t.chrome)),
          open: () => { openVm(m.name, here ? v.tab ?? "overview" : "overview"); showCenter("mp-view"); }, toggle: () => this.toggleOpen(key),
          right: { text: st?.ok ? pct(st.cpu) : "–", lock: lk, tip: `${m.name} · ${label}${st?.ok ? ` · CPU ${pct(st.cpu)} · RAM ${pct(st.ram)} · Disk ${pct(st.disk)}` : st?.err ? " · " + st.err : ""}${lk ? "\n" + lockTip(lk) : ""}` } });
        if (!open) continue;
        const child = (k, label, icon) => rows.push({ key: `${key}/${k}`, parent: key, level: 2, label, sec, exp: null, icon: () => iconEl(icon, t.muted, 13),
          sel: here && (v.tab ?? "overview") === k,
          open: () => { if (k === "editor") { openVm(m.name, "editor"); import("./editor.js").then((e) => e.openEditor(m.name)); } else { openVm(m.name, k); showCenter("mp-view"); } } });
        child("overview", "Overview", "activity");
        child("editor", "Editor", "file-text");
        child("access", "Access", "key");
      }
    } else {
      // Every agent, grouped VS Code / JetBrains tree style: one header per project (its tile + full name +
      // agent count; collapsible, open by default), its agents under it; loose agents in a "Loose agents"
      // group last. No per-row project badge (they truncated); the project is the group.
      const all = allAgents(this.projects);
      count = all.length;
      const groups = [];
      for (const p of this.projects.filter((x) => !x.loose)) { const ag = all.filter((x) => x.p === p); if (ag.length) groups.push({ id: p.slug, name: p.name, p, ag }); }
      const loose = all.filter((x) => x.p.loose);
      if (loose.length) groups.push({ id: "*loose", name: "Loose agents", p: null, ag: loose });
      for (const g of groups) {
        const gHit = q && hit(g.name);
        const ag = q && !gHit ? g.ag.filter(({ p, a }) => hit(`${a.name} ${a.role ?? ""}`)) : g.ag;
        if (!ag.length) continue;
        const key = `agp:${g.id}`;
        const shut = `${key}:shut`; // groups start open; the tree remembers the closed ones
        const open = !this.isOpen(shut) || Boolean(q);
        const lives = ag.map(({ p, a }) => liveAgent(p, a.name)).filter(Boolean);
        const working = lives.filter((x) => x.status === "working").length;
        const selIn = ag.some(({ p, a }) => v.kind === "project" && v.slug === p.slug && (p.loose || (v.tab === "agent" && v.agent === a.name)));
        const toggle = () => this.toggleOpen(shut);
        rows.push({ key, level: 1, label: g.name, sec, group: true, exp: open, sel: selIn && !open, toggle, open: toggle,
          ref: g.p ? { kind: "project", slug: g.p.slug, label: g.p.name } : null,
          icon: () => (g.p ? tile(g.p.name, { kind: "project", size: 14, color: g.p.color, radius: 3 }) : iconEl("bot", t.muted, 13)),
          right: { count: ag.length, tip: `${g.name} · ${ag.length} agent${ag.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}` } });
        if (!open) continue;
        for (const { p, a } of ag) {
          const la = liveAgent(p, a.name);
          const sel = v.kind === "project" && v.slug === p.slug && (p.loose || (v.tab === "agent" && v.agent === a.name));
          rows.push({ key: `ag:${p.slug}:${a.name}`, parent: key, level: 2, label: a.name, sec, exp: null, sel,
            ref: p.loose ? { kind: "loose", slug: p.slug, label: a.name } : { kind: "agent", slug: p.slug, name: a.name },
            icon: () => this.agentIcon(t, a.name, la), open: () => { openAgentPage(p.slug, a.name, "agents"); showCenter("mp-view"); },
            right: { dot: dotOf(la), lead: !p.loose && a.name === leadOf(p), tip: `${a.name} · ${p.loose ? "loose agent" : p.name}${!p.loose && a.name === leadOf(p) ? " · team lead" : ""} · ${la?.status ?? "stopped"}` } });
        }
      }
    }
    return { sec, title: SECTIONS.find(([k]) => k === sec)?.[1] ?? "", count, rows };
  }

  agentIcon(t, name, live) {
    return h_flex().relative().flex_none().size(14).rounded_full().items_center().justify_center().bg(live ? colorFor(`agent:${name}`) : "#3a3f47")
      .when(isWaiting(name, live), (el) => el.border_1().border_color(WARN))
      .child(iconEl("bot", "#ffffff", 9));
  }

  // ------------------------------------------------------------ rendering
  label(t, text, color) {
    const q = this.q, s = String(text);
    const i = q ? s.toLowerCase().indexOf(q) : -1;
    const base = div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(color);
    if (i < 0) return base.child(s);
    return base.child(h_flex().min_w(0).child(div().flex_none().child(s.slice(0, i)))
      .child(div().flex_none().text_color(t.accent).font_semibold().child(s.slice(i, i + q.length)))
      .child(div().min_w(0).truncate().child(s.slice(i + q.length))));
  }

  row(t, n) {
    const focus = this.kbOn && this.kbSel === n.key;
    const indent = T.sp.md + (n.level - 1) * INDENT;
    const r = n.right;
    const fg = n.sel ? t.foreground : t.muted;
    let el = h_flex().id(`mp-tr-${n.key}`).relative().flex_none().h(ROW).pl(indent).pr(T.sp.md).gap(T.sp.sm).items_center().cursor_pointer()
      .border_1().border_color(focus ? t.accent : clear)
      .bg(n.sel ? t.selected : clear).hover((s) => s.bg(n.sel ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => { this.kbSel = n.key; globalThis.__hvZone = "sidebar"; try { K(this).fh?.focus(); } catch {} cx.notify(); })
      .on_click((_e, cx) => { if (n.group) n.toggle(cx); else { n.open(); if (n.exp === false) n.toggle(cx); } cx.notify(); });
    // Indent guides (one per ancestor level, VS Code "tree.renderIndentGuides").
    for (let i = 1; i < n.level; i++) el = el.child(div().absolute().top(0).bottom(0).left(T.sp.md + (i - 1) * INDENT + 5).w(1).bg(t.border));
    // Flat lists (Agents) need no chevron column.
    if (n.exp != null || n.level > 1 || n.sec !== "agents") el = el.child(h_flex().id(`mp-tr-chev-${n.key}`).flex_none().size(12).items_center().justify_center().text_color(t.dim)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (n.exp != null) { n.toggle(cx); cx.notify(); } })
      .when(n.exp != null, (c) => c.child(iconEl(n.exp ? "chevron-down" : "chevron-right", null, 12))));
    return el.when(Boolean(n.icon), (e) => e.child(n.icon()))
      .child(this.label(t, n.label, fg))
      .when(Boolean(r?.lock), (e) => e.child(iconEl("lock", WARN, 11)))
      // Team lead (answers team messages, gets epics): a quiet "lead" after the name.
      .when(Boolean(r?.lead), (e) => e.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("lead")))
      .when(r?.count != null && r?.count !== 0, (e) => e.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(String(r.count))))
      .when(r?.text != null, (e) => e.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(r.text)))
      // Project badge (Agents section): the project's colour dot + its name, quiet.
      .when(Boolean(r?.tag), (e) => e.child(h_flex().flex_none().max_w(64).h(16).px(T.sp.xs).gap(T.sp.xs).items_center().rounded(T.r.chip).bg(t.raised)
        .when(Boolean(r.tagColor), (x) => x.child(div().flex_none().size(T.dot).rounded(2).bg(r.tagColor)))
        .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(r.tag))))
      .when(Boolean(r?.badge), (e) => e.child(h_flex().flex_none().h(14).min_w(14).px(T.sp.xs).rounded(T.r.chip).bg("#d4a35a26").items_center().justify_center()
        .text_size(T.text.micro).font_semibold().text_color(WARN).child(String(Math.min(99, r.badge)))))
      .when(Boolean(r?.tag) || Boolean(r?.dot), (e) => e.child(div().flex_none().size(T.dot).rounded_full().bg(r?.dot ?? clear)))
      .when(Boolean(r?.tip), (e) => e.tooltip(r.tip));
  }

  // Activity bar: icon cells with an accent bar on the left edge of the mode's icon; tooltip names the key.
  activityBar(t, v) {
    const lit = modeOf(v);
    const aFocus = Boolean(K(this).fhA?.is_focused?.());
    const mailN = shared("mp.mailboxN") ?? 0;
    const cell = (a) => {
      const active = a.id === lit, kb = aFocus && this.actSel === a.id;
      const key = keyOf(a.cmd);
      const tip = `${a.label}${key ? `  ${keyLabel(key)}` : a.g ? `  ${a.g}` : ""}${active && MODES[a.id]?.section ? "\nAgain: show / hide the explorer" : ""}`;
      return h_flex().id(`mp-act-${a.id}`).relative().flex_none().w(RAIL).h(CELL).items_center().justify_center().cursor_pointer().tooltip(tip)
        .on_mouse_down("left", (_e, cx) => { this.actSel = a.id; globalThis.__hvZone = "activity"; cx.stop_propagation(); })
        .on_click((_e, cx) => this.activate(a, cx))
        .child(div().absolute().left(0).top(T.sp.md).bottom(T.sp.md).w(2).rounded_full().bg(active ? t.accent : clear))
        .child(h_flex().size(32).rounded(T.r.ctrl).items_center().justify_center().border_1().border_color(kb ? t.accent : clear)
          .bg(active ? t.hover : clear).hover((s) => s.bg(t.hover))
          .child(iconEl(a.icon, active ? t.foreground : t.dim, 18)))
        .when(a.id === "mailbox" && mailN > 0, (el) => el.child(h_flex().absolute().right(T.sp.sm).top(T.sp.xs).h(14).min_w(14).px(T.sp.xs).rounded(T.r.panel).bg(WARN)
          .items_center().justify_center().text_size(T.text.micro).font_semibold().text_color("#ffffff").child(String(Math.min(99, mailN)))));
    };
    return v_flex().id("mp-activity").flex_none().w(RAIL).h_full().pt(T.sp.xs).pb(T.sp.xs).bg(t.chrome).border_r_1().border_color(t.border)
      .when(Boolean(K(this).fhA), (el) => el.track_focus(K(this).fhA)).key_context("HvActivity").on_key_down((e, cx) => this.actKey(e, cx))
      .on_size_change(measure("side.rail"))
      .children(ACTIVITY.filter((a) => !a.bottom).map(cell))
      .child(div().flex_1())
      .children(ACTIVITY.filter((a) => a.bottom).map(cell));
  }

  // Mode switch. The lit mode's icon again: show / hide the explorer (remembered for the mode).
  activate(a, cx) {
    if (a.id === "settings") { run("app.settings", {}); return; }
    if (modeOf(view()) === a.id && MODES[a.id]?.section) { userToggleLeft(cx); return; }
    openMode(a.id);
  }

  actKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || !K(this).fhA?.is_focused()) return;
    const ids = ACTIVITY.map((a) => a.id);
    let i = Math.max(0, ids.indexOf(this.actSel));
    if (k === "down" || k === "j") i = Math.min(ids.length - 1, i + 1);
    else if (k === "up" || k === "k") i = Math.max(0, i - 1);
    else if (k === "home") i = 0;
    else if (k === "end") i = ids.length - 1;
    else if (k === "enter" || k === "space") {
      const a = ACTIVITY[i];
      if (a.id === "settings") run("app.settings", {});
      else openMode(a.id).then(() => { if (k === "enter") setShared("mp.focus", { to: MODES[a.id]?.section ? "sidebar" : "view", at: Date.now() }); });
    }
    else if (k === "right" || k === "l" || k === "tab") setShared("mp.focus", { to: "sidebar", at: Date.now() });
    else if (k === "escape") setShared("mp.focus", { to: "view", at: Date.now() });
    else return;
    this.actSel = ids[i];
    cx.stop_propagation();
    cx.notify();
  }

  // ------------------------------------------------------------ tree keyboard (WAI-ARIA APG tree view)
  pickFirstMatch() {
    if (!this.q) return;
    const n = (K(this).kbList ?? []).find((x) => x.label.toLowerCase().includes(this.q));
    if (n) this.kbSel = n.key;
  }
  kbKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || !K(this).fh?.is_focused()) return;
    const list = K(this).kbList ?? [];
    let i = list.findIndex((x) => x.key === this.kbSel);
    const cur = list[i];
    const toView = () => { globalThis.__hvSideFocus = false; setShared("mp.focus", { to: "view", at: Date.now() }); };
    const pick = (n) => { if (n) this.kbSel = n.key; };
    if (k === "down") pick(list[i < 0 ? 0 : Math.min(list.length - 1, i + 1)]);
    else if (k === "up") pick(list[i < 0 ? 0 : Math.max(0, i - 1)]);
    else if (k === "home") pick(list[0]);
    else if (k === "end") pick(list[list.length - 1]);
    else if (k === "pagedown") pick(list[Math.min(list.length - 1, Math.max(0, i) + 10)]);
    else if (k === "pageup") pick(list[Math.max(0, i - 10)]);
    else if (k === "enter") { if (!cur) pick(list[0]); else if (cur.group) cur.toggle(cx); else { cur.open(); toView(); } }
    else if (k === "space") cur?.open();
    else if (k === "right") {
      if (!cur) pick(list[0]);
      else if (cur.exp === false) cur.toggle(cx);
      else if (cur.exp === true) pick(list[i + 1]?.level > cur.level ? list[i + 1] : null);
      else if (cur.ref) import("./actions.js").then((a) => a.openActions(cur.ref));
    }
    else if (k === "left") {
      if (cur?.exp === true) cur.toggle(cx);
      else if (cur?.parent) pick(list.find((x) => x.key === cur.parent));
      else setShared("mp.focus", { to: "activity", at: Date.now() });
    }
    else if (k === "*") { for (const x of list) if (cur && x.level === cur.level && x.parent === cur.parent && x.exp === false) x.toggle(cx); }
    else if (k === "." || k === "menu" || (k === "f10" && m.shift)) { if (cur?.ref) import("./actions.js").then((a) => a.openActions(cur.ref)); }
    else if (k === "+" || (k === "=" && m.shift) || k === "insert") this.addOf(this.sec ?? "projects")?.[1]();
    else if (k === "/") { cx.spawn(async () => this.filter.focus()); }
    else if (k === "?") { import("./palette.js").then((p) => p.openPaletteWith({ mode: "keys" })); }
    else if (k === "escape") { if (this.q) { this.filter.set_value(""); this.q = ""; } else toView(); }
    else if (k === "backspace" && this.q) { this.filter.set_value(this.q.slice(0, -1)); this.q = this.q.slice(0, -1); }
    else if (k.length === 1 && /[\p{L}\p{N}_\-]/u.test(k)) {
      // Type-ahead: letters typed quickly form a prefix; focus moves to the next node starting with it.
      const now = Date.now();
      this.ta = now - (this.taAt ?? 0) < 700 ? (this.ta ?? "") + k.toLowerCase() : k.toLowerCase();
      this.taAt = now;
      const order = [...list.slice(i + (this.ta.length > 1 ? 0 : 1)), ...list.slice(0, i + 1)];
      pick(order.find((x) => x.label.toLowerCase().startsWith(this.ta)));
    }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Focus requests (shared "mp.focus"): "activity", "sidebar" (explorer; reveal: a section — switches to its
  // mode when another one is shown), "find" / "filter".
  takeFocus(cx, v) {
    const fr = shared("mp.focus");
    if (!fr || fr.at === this.focusAt) return;
    this.focusAt = fr.at;
    if (Date.now() - fr.at > 3000) return;
    if (fr.to === "activity") {
      globalThis.__hvZone = "activity";
      if (!this.actSel) this.actSel = modeOf(v);
      cx.timer.after(1, (cx) => { K(this).fhA?.focus(); cx.notify(); cx.timer.after(60, (cx) => cx.notify()); });
    } else if (fr.to === "sidebar" || fr.to === "filter" || (fr.to === "find" && !(v.kind === "project" && v.tab === "tasks"))) {
      globalThis.__hvSideFocus = true;
      globalThis.__hvZone = "sidebar";
      const want = fr.reveal ? modeOfSection(fr.reveal) : null;
      const switching = want && sectionOf(modeOf(v)) !== sectionOf(want);
      if (switching) openMode(want);
      const later = isCollapsed(LEFT) || switching;
      if (isCollapsed(LEFT) && !switching) userToggleLeft(cx);
      const list = K(this).kbList ?? [];
      if (!switching && (!this.kbSel || !list.some((x) => x.key === this.kbSel) || fr.reveal)) this.kbSel = list.find((x) => x.sel)?.key ?? list[0]?.key ?? null;
      if (switching) this.kbSel = null; // the selected row of the new section is picked once it is built
      const typing = fr.to !== "sidebar";
      cx.timer.after(later ? 300 : 1, (cx) => {
        if (!this.kbSel) this.kbSel = (K(this).kbList ?? []).find((x) => x.sel)?.key ?? K(this).kbList?.[0]?.key ?? null;
        if (typing) this.filter.focus(); else K(this).fh?.focus();
        cx.notify(); cx.timer.after(60, (cx) => cx.notify());
      });
    } else if (fr.to !== "sidebar") globalThis.__hvSideFocus = false;
  }

  // Mode bookkeeping (this copy is always shown, so it does it for the others): applies the mode's panels
  // when the view moves to another mode, remembers each mode's last view, opens the hidden chat column
  // while a task panel or a chat request needs it, and turns old "open agent" jumps into the agent page.
  syncMode(cx, v) {
    const G = globalThis;
    const mode = modeOf(v);
    const M = modeViews();
    if (JSON.stringify(M[mode] ?? null) !== JSON.stringify(v)) { M[mode] = v; cx.timer.after(1, () => setShared("mp.modeView", { ...M })); }
    if (G.__hvModeNow !== mode) {
      G.__hvModeNow = mode;
      G.__hvChatAuto = false;
      cx.timer.after(1, (cx) => { applyMode(mode, cx); cx.notify(); });
    }
    const fresh = (x) => Boolean(x?.at) && Date.now() - x.at < 4000;
    const tp = shared("mp.taskPanel");
    const tpAt = tp?.at ?? null;
    if (tpAt !== this.tpAt) {
      this.tpAt = tpAt;
      if (fresh(tp) && chatState() === "hidden") { G.__hvChatAuto = true; cx.timer.after(1, (cx) => setChat("open", cx)); }
      else if (!tp && G.__hvChatAuto) { G.__hvChatAuto = false; if (wantedLayout(mode).right === "hidden") cx.timer.after(1, (cx) => setChat("hidden", cx)); }
    }
    const cg = shared("mp.chatGo"), fz = shared("mp.focus");
    const ask = (fresh(cg) && cg.at !== this.cgAt) || (fz?.to === "chat" && fresh(fz) && fz.at !== this.fzAt);
    this.cgAt = cg?.at; this.fzAt = fz?.at;
    if (ask && chatState() === "hidden") { G.__hvChatAuto = true; cx.timer.after(1, (cx) => setChat("open", cx)); }
    const oa = shared("mp.openAgent");
    if (oa?.name && oa.slug && oa.at !== G.__hvOaSeen && Date.now() - oa.at < 10000) {
      G.__hvOaSeen = oa.at;
      cx.timer.after(1, () => openAgentPage(oa.slug, oa.name, mode === "agents" ? "agents" : "projects"));
    }
  }

  // The usage limits live in the status bar; the sidebar footer only warns: a provider that needs a
  // login (with a Log In action) or one whose main window is under 15 %. Nothing to warn about: no footer.
  limitsLine(t) {
    const warn = limitRows().map((r) => {
      const main = r.wins[0]?.[1];
      const signedOut = Boolean(r.err) && r.err !== "Checking…";
      return signedOut ? { r, signedOut, text: `${r.name}: login needed` }
        : main && main.pct < 15 ? { r, main, text: `${r.name}: ${Math.round(main.pct)}% left${main.reset ? ` · resets in ${until(main.reset)}` : ""}` } : null;
    }).filter(Boolean);
    if (!warn.length) return null;
    return v_flex().id("mp-limits").flex_none().py(T.sp.xs).border_t_1().border_color(t.border)
      .on_size_change(measure("side.limits"))
      .children(warn.map(({ r, signedOut, text }) => h_flex().id(`mp-lim-${r.key}`).h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center()
        .tooltip(`${r.name}\n${limitTip(r)}`)
        .child(iconEl("alert", signedOut ? WARN : BAD, 12))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(signedOut ? t.muted : BAD).child(text))
        .child(h_flex().id(`mp-lim-go-${r.key}`).flex_none().h(20).px(T.sp.sm).rounded(T.r.chip).items_center().cursor_pointer()
          .border_1().border_color(t.border).text_size(T.text.xs).font_medium().text_color(signedOut ? WARN : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => (signedOut ? loginProvider(r.key) : this.loadLimits(cx)))
          .child(signedOut ? "Log In" : "Refresh"))));
  }

  render(cx) {
    const t = theme();
    const v = view();
    // Hot reload keeps old instances without re-running init: make the state lazily (not in render).
    if ((!K(this).fh || !K(this).fhA || !this.filter) && !K(this).asked) { K(this).asked = true; cx.timer.after(1, (cx) => { this.ensureState(cx); K(this).asked = false; cx.notify(); }); }
    this.expanded ??= new Set(); this.projects ??= []; this.machines ??= [];
    this.syncMode(cx, v);
    pumpFocus(cx); // gives the keyboard back after an overlay closed (lib.js focus manager)
    const tl = shared("mp.toggleLeft"); // Ctrl+Shift+B (shortcuts.js)
    if (tl && tl !== this.toggleLeftAt) { const fresh = this.toggleLeftAt !== undefined || Date.now() - tl < 1500; this.toggleLeftAt = tl; if (fresh && Date.now() - tl < 1500 && !globalThis.__hvToggling) { globalThis.__hvToggling = true; userToggleLeft(cx); cx.timer.after(400, () => { globalThis.__hvToggling = false; }); } }
    const fl = shared("mp.limitsAsk");
    if (fl && fl !== this.limitsAsk) { this.limitsAsk = fl; this.loadLimits(cx); }
    const se = JSON.stringify(shared("mp.expanded") ?? []);
    if (se !== this.lastExp) { const was = this.lastExp; this.lastExp = se; this.expanded = new Set(JSON.parse(se)); if (was !== undefined) this.reload(cx); }
    if (K(this).fh) this.takeFocus(cx, v);
    const reg = (globalThis.__hvFH ??= {});
    if (K(this).fh) reg.sidebar = K(this).fh;
    if (K(this).fhA) reg.activity = K(this).fhA;
    this.kbOn = Boolean(K(this).fh?.is_focused?.());
    if (Date.now() - (shared("mp.focus")?.at ?? 0) > 1500) globalThis.__hvSideFocus = this.kbOn; // Ctrl+Shift+E toggles back
    const rail = this.activityBar(t, v);
    if (isCollapsed(LEFT)) return h_flex().id("mp-sidebar").size_full().bg(t.chrome).on_size_change(measure("side")).child(rail);

    const sec = sectionOf(modeOf(v));
    this.sec = sec;
    const group = this.build(t, v, sec);
    const flat = group.rows;
    K(this).kbList = flat;
    if (this.kbSel && !flat.some((x) => x.key === this.kbSel)) this.kbSel = flat.find((x) => x.sel)?.key ?? flat[0]?.key ?? null;
    // Keep the keyboard row on screen (rows are direct children of the scroll column).
    const at = flat.findIndex((x) => x.key === this.kbSel);
    if (this.kbOn && at >= 0 && at !== this.lastAt) { this.lastAt = at; try { K(this).scroll?.scroll_to_item(at); } catch {} }
    // Tutorial geometry (tour.js): the shown section's height in window px (zoomed), from the row count.
    let zm = 1;
    try { zm = Number(settings()?.zoom) || 1; } catch {}
    for (const [k] of SECTIONS) tourSizes()[`side.${k === "agents" ? "loose" : k}`] = { w: (tourSizes()["side.explorer"]?.w ?? 220), h: k === sec ? flat.length * ROW * zm : 0 };
    tourSizes()["side.dashboard"] = { w: 0, h: 0 };

    const add = this.addOf(sec);
    const head = v_flex().flex_none().on_size_change(measure("side.search"))
      .child(h_flex().h(32).pl(T.sp.lg).pr(T.sp.sm).gap(T.sp.sm).items_center()
        .child(div().flex_none().text_size(T.text.xs).font_semibold().text_color(t.muted).child(group.title.toUpperCase()))
        .child(div().flex_1().min_w(0).text_size(T.text.xs).text_color(t.dim).child(String(group.count)))
        .when(Boolean(add), (el) => el.child(h_flex().id(`mp-tr-add-${sec}`).flex_none().size(20).rounded(T.r.chip).items_center().justify_center().cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`${add[0]} (+)`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); add[1](); }).child(iconEl("plus", null, 13))))
        .child(h_flex().id("mp-search-k").flex_none().whitespace_nowrap().h(18).px(T.sp.xs).gap(T.sp.xxs).items_center().rounded(T.r.chip).cursor_pointer()
          .border_1().border_color(t.border).text_size(T.text.xs).text_color(t.dim).hover((s) => s.text_color(t.foreground).border_color(t.accent))
          .tooltip("Command palette (Ctrl+K)").on_click((_e, cx) => { cx.stop_propagation(); openPalette(); })
          .child("Ctrl K")))
      .child(h_flex().id("mp-search").key_context("HvTreeFilter").flex_none().mx(T.sp.md).mb(T.sp.sm).h(24).px(T.sp.sm).gap(T.sp.sm).items_center().rounded(T.r.ctrl)
        .bg(t.background).border_1().border_color(this.q ? t.accent : t.border)
        .on_action("hv_tree_into", (_e, cx) => { this.pickFirstMatch(); K(this).fh?.focus(); cx.notify(); })
        .on_action("hv_tree_enter", (_e, cx) => { this.pickFirstMatch(); const n = flat.find((x) => x.key === this.kbSel); if (n && this.q) { n.open(); setShared("mp.focus", { to: "view", at: Date.now() }); } else K(this).fh?.focus(); cx.notify(); })
        .on_action("hv_tree_esc", (_e, cx) => { this.filter.set_value(""); this.q = ""; K(this).fh?.focus(); cx.notify(); })
        .child(iconEl("search", t.dim, 12))
        .child(this.filter ? Input.new(this.filter).flex_1().h(22).text_size(T.text.sm).text_color(t.foreground) : div().flex_1())
        .when(Boolean(this.q), (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`${flat.length}`))));

    const body = v_flex().pb(T.sp.md).children(flat.map((n) => this.row(t, n)))
      .when(flat.length === 0 && Boolean(this.q), (el) => el.child(div().px(T.sp.lg).py(T.sp.md).text_size(T.text.sm).text_color(t.dim).child(`Nothing matches "${this.q}"`)))
      .when(flat.length === 0 && !this.q && Boolean(add), (el) => el.child(h_flex().id("mp-tr-empty").h(ROW).px(T.sp.lg).gap(T.sp.sm).items_center().cursor_pointer()
        .text_size(T.text.sm).text_color(t.accent).hover((s) => s.opacity(0.8)).on_click(() => add[1]()).child(iconEl("plus", t.accent, 12)).child(add[0])));
    const explorer = v_flex().id("mp-explorer").flex_1().min_w(0).h_full().bg(t.chrome)
      .when(Boolean(K(this).fh), (el) => el.track_focus(K(this).fh)).key_context("HvSide").on_key_down((e, cx) => this.kbKey(e, cx))
      .on_size_change(measure("side.explorer"))
      .child(head)
      .child(scrollY("mp-side-scroll", K(this).scroll ? body.track_scroll(K(this).scroll) : body))
      .child(((warn) => v_flex().id("mp-side-bottom").flex_none().on_size_change(measure("side.bottom")).when(Boolean(warn), (el) => el.child(warn)))(this.limitsLine(t)));
    return h_flex().id("mp-sidebar").size_full().bg(t.chrome).text_color(t.foreground)
      .on_size_change(measure("side"))
      .child(rail)
      .child(explorer);
  }
}
