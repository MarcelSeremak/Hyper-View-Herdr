// Window lights + brand, the view header (one slim breadcrumb row + icon actions) and the terminal tab strip.
// Also: the activity-bar modes (which panels each mode shows), animated collapse of the left sidebar and the
// right conversation panel to icon rails, and hiding the conversation column in modes without chat.
import { T } from "./tokens.js";
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, window, run, spaces, shared, setShared, openOverlay, closeOverlay, props, hc, layout } from "herdr";
import {
  MOD, rememberFocus, listProjects, selectProject, projectSpace, view, openTab, centerShown, showCenter, loadProject, loadMachines, loadSecrets, watchData, claimJob, repeat, liveAgent, tile, iconButton, button,
  pill, tabsBar, measure, vmStats, vmHealth, openSsh, connectVm, installKey, OK, WARN, icon, clear, hp, toast,
} from "./lib.js";
import { openForm } from "./form.js";

// ------------------------------------------------------------ collapsing panels
export const LEFT = { id: "mp-sidebar-col", open: 268, rail: 48, key: "mp.leftCollapsed" };
export const RIGHT = { id: "mp-chat-col", open: 380, rail: 60, key: "mp.rightCollapsed" };
export const isCollapsed = (p) => Boolean(shared(p.key));
const ease = (x) => 1 - Math.pow(1 - x, 3);
// Resizes in small steps (~180 ms) so the panel slides instead of jumping.
// `start`: the panel's current width when it is not p.open (the chat can be full width).
export function togglePanel(p, cx, start) {
  const collapse = !isCollapsed(p);
  const from = collapse ? start ?? p.open : p.rail, to = collapse ? p.rail : p.open;
  if (collapse) setShared(p.key, true); // switch content to the rail first
  slidePx(cx, p.id, from, to, () => { if (!collapse) setShared(p.key, false); });
}
function slidePx(cx, id, from, to, done) {
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    cx.timer.after(i * 18, () => {
      run("layout.resize", { id, px: Math.round(from + (to - from) * ease(i / steps)) });
      if (i === steps) done?.();
    });
  }
}

// ------------------------------------------------------------ modes (activity bar)
// The activity bar picks a mode; each mode decides whether the explorer (left) and the chat column (right)
// are shown. VS Code model: the lit icon = the mode of the open view (derived from shared "mp.view", so the
// palette, dashboard links and keys all land in the right mode). Manual changes (Ctrl+Shift+B, the panel
// buttons) are remembered per mode in shared "mp.modeLayout" = { mode: { left: "open"|"rail", right: "open"|"rail"|"hidden" } }.
export const MODES = {
  dash: { left: "rail", right: "hidden" },
  projects: { left: "open", right: "open", section: "projects" },
  vms: { left: "open", right: "hidden", section: "vms" },
  agents: { left: "open", right: "open", section: "agents" },
  mailbox: { left: "rail", right: "open" }, // chat on the right half (chat.js), questions on the left
  tokens: { left: "rail", right: "hidden" },
  map: { left: "rail", right: "hidden" },
  clipboard: { left: "rail", right: "hidden" },
  skills: { left: "rail", right: "hidden" },
  mcp: { left: "rail", right: "hidden" },
  settings: { left: "rail", right: "hidden" },
};
// Loose agents are projects of their own (slug agent-<name>); the sidebar keeps the exact set.
export const isLooseSlug = (slug) => globalThis.__hvLoose?.has?.(slug) ?? String(slug ?? "").startsWith("agent-");
export function modeOf(v) {
  switch (v?.kind) {
    case "project": return isLooseSlug(v.slug) || v.via === "agents" ? "agents" : "projects";
    case "vm": case "machines": return "vms";
    case "secrets": return "tokens";
    case "map": return "map";
    case "mailbox": case "clipboard": case "settings": case "skills": case "mcp": return v.kind;
    default: return "dash";
  }
}
// The agent page (project agents and loose agents alike). via: "agents" (Agents mode) or "projects".
export function openAgentPage(slug, name, via = "projects") {
  if (isLooseSlug(slug)) { setShared("mp.view", { kind: "project", slug, tab: "agent", agent: name, via: "agents" }); return; }
  setShared("mp.project", slug);
  setShared("mp.view", { kind: "project", slug, tab: "agent", agent: name, via });
}
export const chatHidden = () => Boolean(shared("mp.chatHidden"));
export const chatState = () => (chatHidden() ? "hidden" : isCollapsed(RIGHT) ? "rail" : "open");
// Shows the chat column open / as its rail, or hides it (slides to 0, then layout.hide). Animated like togglePanel.
export function setChat(state, cx) {
  const cur = chatState();
  if (cur === state) return;
  const id = RIGHT.id;
  if (state === "hidden") {
    const from = cur === "rail" ? RIGHT.rail : shared("mp.chatFull") ? layoutPxOf(id) ?? RIGHT.open : RIGHT.open;
    setShared("mp.chatHidden", true); // the chat draws an empty panel while it slides away
    if (shared("mp.chatFull")) setShared("mp.chatFull", false);
    slidePx(cx, id, from, 0, () => run("layout.hide", { id }));
    return;
  }
  const to = state === "rail" ? RIGHT.rail : RIGHT.open;
  if (cur === "hidden") {
    setShared(RIGHT.key, state === "rail");
    run("layout.resize", { id, px: 0 });
    run("layout.show", { id });
    slidePx(cx, id, 0, to, () => setShared("mp.chatHidden", false));
    return;
  }
  togglePanel(RIGHT, cx); // open <-> rail
}
// Puts the explorer and the chat the way the mode wants them (defaults + remembered overrides).
export function wantedLayout(mode) { return { ...(MODES[mode] ?? MODES.dash), ...((shared("mp.modeLayout") ?? {})[mode] ?? {}) }; }
export function applyMode(mode, cx) {
  const want = wantedLayout(mode);
  if ((want.left === "rail") !== isCollapsed(LEFT)) togglePanel(LEFT, cx);
  setChat(want.right, cx);
}
// A manual change of a panel: remembered for the mode of the open view.
export function rememberLayout(part, state) {
  const mode = modeOf(view());
  const all = shared("mp.modeLayout") ?? {};
  setShared("mp.modeLayout", { ...all, [mode]: { ...(all[mode] ?? {}), [part]: state } });
}
export function userToggleLeft(cx) {
  rememberLayout("left", isCollapsed(LEFT) ? "open" : "rail");
  togglePanel(LEFT, cx);
}

// Red / yellow / green. On macOS the system draws them, so we only keep the space.
export function windowDots(t, hover, prefix) {
  const w = window();
  if (!w.buttons) return div().flex_none().w(56);
  const dot = (id, color, glyph, cmd) => h_flex().id(`${prefix}-${id}`).size(12).rounded_full().bg(w.active ? color : t.input)
    .items_center().justify_center().cursor_pointer().text_size(T.text.micro).font_bold().text_color("#00000099")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => run(cmd))
    .child(hover ? glyph : "");
  return h_flex().flex_none().gap(8).items_center()
    .child(dot("close", "#ff5f57", "×", "window.close"))
    .child(dot("min", "#febc2e", "−", "window.minimize"))
    .child(dot("max", "#28c840", w.maximized ? "↙" : "↗", "window.maximize"));
}

export class Lights {
  init() { this.hover = false; }
  render(cx) {
    const t = theme();
    if (isCollapsed(LEFT)) {
      return h_flex().id("mp-lights").size_full().items_center().justify_center().on_size_change(measure("lights"))
        .child(h_flex().id("mp-logo-rail").size(32).rounded(T.r.panel).items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => userToggleLeft(cx)).tooltip("Expand sidebar  Ctrl+Shift+B")
          .child(image(icon("logo")).size(20)));
    }
    return h_flex().id("mp-lights").size_full().pl(T.sp.lg).pr(T.sp.sm).gap(T.sp.md).items_center().on_size_change(measure("lights"))
      .on_hover((h, cx) => { this.hover = h; cx.notify(); })
      .child(windowDots(t, this.hover, "mp-l"))
      .child(h_flex().gap(T.sp.sm).items_center()
        .child(image(icon("logo")).size(18))
        .child(div().text_size(T.text.base).font_semibold().text_color(t.foreground).child("Herdr")))
      .child(div().flex_1())
      .child(h_flex().id("mp-tutorial").h(20).px(T.sp.sm).rounded(T.r.chip).items_center().cursor_pointer().border_1().border_color(t.border)
        .text_size(T.text.xs).text_color(t.dim).hover((s) => s.text_color(t.foreground).border_color(t.accent))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => import("./tour.js").then((m) => m.startTour())).tooltip("Take a short guided tour (demo data)")
        .child("Tour"))
      .child(iconButton(t, "mp-collapse-left", "sidebar", (_e, cx) => userToggleLeft(cx), "Collapse sidebar  Ctrl+Shift+B"));
  }
}

// ------------------------------------------------------------ header
// IDE-style, one slim row (no tab strip: the explorer is the navigation): breadcrumb
// (Projects › E-commerce › Tasks) + status + icon actions. Keyboard (F6 zone "header"): ←/→ previous / next
// sub-view of the project or machine (the explorer's children), Home/End, 1–6, Enter/↓ into the view,
// "." the entity's actions (palette), Esc back to the view.
export const PROJECT_TABS = [["overview", "Overview"], ["agents", "Agents"], ["tasks", "Tasks"], ["epics", "Epics"], ["machines", "Machines"], ["credentials", "Credentials"], ["activity", "Activity"]];
export const VM_TABS = [["overview", "Overview"], ["editor", "Editor"], ["access", "Access"]];
// Opens a sub-view of the current project / machine (the machine Editor starts the editor).
export function pickTab(k) {
  const v = view();
  if (v.kind === "project" && v.tab === "agent") setShared("mp.view", { kind: "project", slug: v.slug, tab: k, ...(v.via ? { via: v.via } : {}) });
  else openTab(k);
  if (v.kind === "vm" && k === "editor") import("./editor.js").then((m) => m.openEditor(v.name));
  else showCenter("mp-view");
}
export function tabsOf(v) { return v.kind === "vm" ? VM_TABS : v.kind === "project" && !isLooseSlug(v.slug) && v.via !== "agents" ? PROJECT_TABS : []; }
// Ctrl+Tab / Ctrl+Shift+Tab (and ←/→ on the focused tab bar): next / previous tab, wrapping.
export function stepTab(d) {
  const v = view();
  const list = tabsOf(v);
  if (!list.length) return false;
  const cur = { agent: "agents", resources: "machines" }[v.tab] ?? v.tab ?? "overview";
  const i = Math.max(0, list.findIndex(([k]) => k === cur));
  pickTab(list[(i + d + list.length) % list.length][0]);
  return true;
}

const KH = new WeakMap();
const KHs = (o) => { let s = KH.get(o); if (!s) KH.set(o, (s = {})); return s; };
// Header block height (layouts/hyper-view.json "mp-header"): the breadcrumb row alone.
export const HEADER_SINGLE = 40;
function layoutPxOf(id) {
  try {
    const walk = (n) => { if (!n || typeof n !== "object") return null; if (n.id === id) return n; for (const c of n.children ?? []) { const f = walk(c); if (f) return f; } return walk(n.root); };
    const px = Number(walk(layout())?.size?.px);
    return Number.isFinite(px) ? px : null;
  } catch { return null; }
}
// Opens the project "…" menu (header button; dev bridge: shared "mp.devMenu").
export const openProjectMenu = (p) => (rememberFocus("pmenu"), openOverlay({ mod: MOD, props: { role: "pmenu", project: p.slug, name: p.name, desc: p.desc ?? "" }, kind: "popup", width: 230, height: 190 }));

export class Header {
  init(cx) {
    this.project = null;
    this.machines = [];
    this.secrets = [];
    this.hover = false;
    try { KHs(this).fh = cx.focus_handle(); } catch {}
    this.focusAt = shared("mp.focus")?.at;
    watchData(cx, (cx) => cx.spawn(async (cx) => {
      const v = view();
      this.project = v.kind === "project" ? await loadProject(v.slug) : this.project;
      this.machines = await loadMachines();
      this.secrets = await loadSecrets();
      cx.notify();
    }), 30000, "header"); // folder watch reloads at once; timer = fallback
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || !KHs(this).fh?.is_focused()) return;
    const v = view();
    const list = tabsOf(v);
    const toView = () => setShared("mp.focus", { to: "view", at: Date.now() });
    if (k === "left" || k === "h") stepTab(-1);
    else if (k === "right" || k === "l") stepTab(1);
    else if (k === "home" && list.length) pickTab(list[0][0]);
    else if (k === "end" && list.length) pickTab(list[list.length - 1][0]);
    else if (/^[1-9]$/.test(k) && list[Number(k) - 1]) pickTab(list[Number(k) - 1][0]);
    else if (k === "enter" || k === "down" || k === "escape" || k === "j") toView();
    else if (k === "." || k === "menu" || (k === "f10" && m.shift)) { const ref = this.ref(v); if (ref) import("./actions.js").then((a) => a.openActions(ref)); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Resizes the header block to `px` when the view switches between tabbed and untabbed (and after a
  // layout reset): the running layout is re-checked at most every 2 s, the resize runs outside render.
  fit(cx, px) {
    if (this.fitPx === px && Date.now() - (this.fitChk ?? 0) < 2000) return;
    this.fitPx = px;
    this.fitChk = Date.now();
    const cur = layoutPxOf("mp-header");
    if (cur == null || Math.abs(cur - px) < 1) return;
    cx.timer.after(1, () => run("layout.resize", { id: "mp-header", px }));
  }

  ref(v) {
    if (v.kind === "project" && this.project?.slug === v.slug) {
      if (this.project.loose) return { kind: "loose", slug: v.slug, label: this.project.agents?.[0]?.name ?? this.project.name };
      if (v.tab === "agent" && v.agent) return { kind: "agent", slug: v.slug, name: v.agent };
      return { kind: "project", slug: v.slug, label: this.project.name };
    }
    if (v.kind === "vm") return { kind: "machine", name: v.name };
    return null;
  }

  render(cx) {
    const t = theme();
    const v = view();
    if (v.kind === "project" && v.slug !== this.project?.slug && this.wanted !== v.slug) {
      this.wanted = v.slug;
      cx.spawn(async (cx) => { this.project = await loadProject(v.slug); cx.notify(); });
    }
    // Focus requests (F6 zone "header"); the handle is made lazily after an in-place reload.
    if (!KHs(this).fh && !KHs(this).asked) { KHs(this).asked = true; cx.timer.after(1, (cx) => { try { KHs(this).fh = cx.focus_handle(); } catch {} cx.notify(); }); }
    const fr = shared("mp.focus");
    if (KHs(this).fh && fr && fr.at !== this.focusAt) {
      this.focusAt = fr.at;
      if (fr.to === "header" && Date.now() - fr.at < 3000) { globalThis.__hvZone = "header"; cx.timer.after(1, (cx) => { KHs(this).fh.focus(); cx.notify(); cx.timer.after(60, (cx) => cx.notify()); }); }
    }
    if (KHs(this).fh) (globalThis.__hvFH ??= {}).header = KHs(this).fh;
    this.kbOn = Boolean(KHs(this).fh?.is_focused?.());
    // One slim row everywhere (40 px): the layout block follows after a layout reset.
    this.fit(cx, HEADER_SINGLE);
    const seg =h_flex().flex_none().p(T.sp.xxs).gap(T.sp.xxs).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
      .children([["mp-view", "Workspace", "layout"], ["mp-terms", "Terminals", "terminal"]].map(([child, label, ic]) => {
        const on = centerShown() === child || (child === "mp-view" && centerShown() === "mp-vmterm");
        return h_flex().id(`mp-seg-${child}`).size(22).rounded(T.r.chip).items_center().justify_center().cursor_pointer()
          .bg(on ? t.surface : clear).text_color(on ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
          .tooltip(`${label}  Ctrl+\``)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => showCenter(child))
          .child(svg(icon(ic)).size(13));
      }));
    const crumbs = (items, lead, status) => h_flex().min_w(0).gap(T.sp.sm).items_center().text_size(T.text.sm)
      .children(items.flatMap((x, i) => {
        const last = i === items.length - 1;
        const [label, onClick] = Array.isArray(x) ? x : [x, null];
        const el = h_flex().id(`mp-crumb-${i}`).flex_none().max_w(260).gap(T.sp.sm).items_center()
          .when(i === 1 && Boolean(lead), (e) => e.child(lead))
          .child(div().truncate().text_color(last ? t.foreground : t.muted).when(last, (d) => d.font_medium()).child(label))
          .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => onClick()));
        return i ? [svg(icon("chevron-right")).flex_none().size(12).text_color(t.dim), el] : [el];
      }))
      .when(Boolean(status), (el) => el.child(div().w(T.sp.xs)).child(status));
    const reveal = (sec) => () => setShared("mp.focus", { to: "sidebar", reveal: sec, at: Date.now() });
    const act = (id, ic, tip, onClick, opts) => iconButton(t, id, ic, onClick, tip, { size: 26, ...(opts ?? {}) });
    const tabLabel = (list) => list.find(([k]) => k === (v.tab ?? "overview"))?.[1] ?? ({ resources: "Machines" }[v.tab] ?? String(v.tab ?? "Overview"));
    const agentPill = (la) => (la ? pill(t, { working: "Working", blocked: "Waiting for you", done: "Finished", idle: "Idle" }[la.status] ?? la.status, la.status === "working" ? OK : la.status === "blocked" ? WARN : "#9aa3ad") : pill(t, "Stopped", "#9aa3ad"));

    if (v.kind === "project") {
      const p = this.project;
      if (!p) return this.frame(t, crumbs([["Projects", reveal("projects")]]), null, seg, null);
      // Agent page (loose agents, or an agent opened from Agents / a project's Agents): its actions are on the page.
      if (p.loose || (v.tab === "agent" && v.agent)) {
        const a = p.loose ? p.agents[0] ?? { name: p.name } : p.agents.find((x) => x.name === v.agent) ?? { name: v.agent };
        const la = liveAgent(p, a.name);
        const lead = tile(a.name, { size: 16, glyph: "bot", color: "#5f7f76", radius: 8 });
        const items = p.loose || v.via === "agents" ? [["Agents", reveal("agents")], a.name]
          : [["Projects", reveal("projects")], [p.name, () => pickTab("overview")], ["Agents", () => pickTab("agents")], a.name];
        return this.frame(t, crumbs(items, p.loose || v.via === "agents" ? lead : tile(p.name, { kind: "project", size: 16, color: p.color, radius: 4 }), agentPill(la)),
          h_flex().gap(T.sp.xs).items_center().child(act("mp-h-amore", "more", "Agent actions  (.)", () => { const ref = this.ref(v); if (ref) import("./actions.js").then((m) => m.openActions(ref)); })),
          seg, null);
      }
      const live = p.agents.map((a) => liveAgent(p, a.name)).filter(Boolean);
      const working = live.filter((a) => a.status === "working").length;
      const paused = p.status === "paused";
      const status = paused ? pill(t, "Paused", "#9aa3ad") : working ? pill(t, `${working} working`, OK) : pill(t, "Idle", "#9aa3ad");
      const actions = h_flex().gap(T.sp.xs).items_center()
        .child(act("mp-h-pause", paused ? "play" : "pause", paused ? "Resume project" : "Pause project", (_e, cx) => {
          cx.spawn(async (cx) => {
            const r = await hp(["project", "set"], { p: p.slug, status: paused ? "active" : "paused" });
            if (!r.ok) toast("Could not update project", r.err, "error");
            await hp(["say", paused ? "Project resumed. Continue your tasks." : "Project paused by the human. Finish your current step and wait (hp wait)."], { p: p.slug, as: "ty" });
          });
        }))
        .child(act("mp-h-task", "check-square", "New task  (palette: New task)", () => openForm("task-add", { project: p.slug })))
        .child(act("mp-h-agent", "bot", "Add agent  (palette: New agent)", () => openForm("agent-new", { project: p.slug }), { color: t.accent }))
        .child(act("mp-h-more", "more", "Project actions  (. on the header)", () => openProjectMenu(p)));
      // Design previews only (dev bridge): shared "mp.devMenu" = { at } opens the "…" menu once.
      const dm = shared("mp.devMenu");
      if (dm && dm.at !== this.devMenuAt && Date.now() - dm.at < 10000) { this.devMenuAt = dm.at; cx.timer.after(1, () => openProjectMenu(p)); }
      return this.frame(t, crumbs([["Projects", reveal("projects")], [p.name, () => pickTab("overview")], tabLabel(PROJECT_TABS)], tile(p.name, { kind: "project", size: 16, color: p.color, radius: 4 }), status),
        actions, seg, p.desc || null);
    }
    if (v.kind === "vm") {
      const m = this.machines.find((x) => x.name === v.name);
      const st = vmStats()[v.name];
      const [label, color] = vmHealth(st);
      const sub = m ? `${st?.os || m.os || "Unknown OS"} · ${m.user}@${m.host}:${m.port ?? 22}` : "";
      const sure = this.confirmRemove === `vm:${v.name}`;
      const actions = m ? h_flex().gap(T.sp.xs).items_center()
        .child(act("mp-h-vssh", "terminal", "Open editor + terminal  (Alt+2)", () => pickTab("editor")))
        .child(act("mp-h-vedit", "pencil", "Edit machine", () => openForm("vm-edit", { machine: m.name, host: m.host, user: m.user, port: String(m.port ?? 22), desc: m.desc ?? "" })))
        .child(sure
          ? button(t, "mp-h-vrm-sure", "Delete?", (_e, cx) => {
            this.confirmRemove = null;
            cx.spawn(async () => {
              const r = await hp(["vm", "rm", m.name]);
              if (!r.ok) { toast("Could not delete machine", r.err, "error"); return; }
              const rest = (await listProjects()).filter((x) => !x.loose);
              selectProject(rest[0]?.slug ?? null, "overview");
              toast(`Deleted ${m.name}`, "The server itself is untouched.", "success");
            });
          }, { small: true, danger: true, iconName: "x" })
          : act("mp-h-vrm", "x", "Delete machine (asks again)", (_e, cx) => { this.confirmRemove = `vm:${v.name}`; cx.notify(); cx.timer.after(3000, (cx) => { this.confirmRemove = null; cx.notify(); }); })) : null;
      return this.frame(t, crumbs([["Machines", reveal("vms")], [v.name, () => pickTab("overview")], tabLabel(VM_TABS)], tile(v.name, { kind: "vm", size: 16, radius: 4 }), pill(t, label, color)),
        actions, seg, sub);
    }
    if (v.kind === "login") {
      const claude = v.provider === "claude";
      return this.frame(t, crumbs(["Log in", claude ? "Claude Code" : "Codex"]), null, null, "Finish signing in in the browser window that opens. Usage limits refresh afterwards.");
    }
    if (v.kind === "dashboard") {
      // No counts here: the Dashboard's own filters show them.
      return this.frame(t, crumbs(["Dashboard"]), act("mp-h-dnew", "plus", "New project", () => openForm("project-new")), seg, null);
    }
    if (v.kind === "mailbox") {
      const n = shared("mp.mailboxN") ?? 0;
      return this.frame(t, crumbs(["Mailbox"]), null, seg, n ? `${n} open` : "All clear");
    }
    if (v.kind === "clipboard") {
      return this.frame(t, crumbs(["Clipboard"]), act("mp-h-clip", "plus", "Add snippet", () => openForm("snippet", {})), seg, null);
    }
    if (v.kind === "skills") return this.frame(t, crumbs(["Skills"]), act("mp-h-skill", "plus", "New skill", () => openForm("skill-edit", {})), seg, null);
    if (v.kind === "mcp") return this.frame(t, crumbs(["MCP servers"]), act("mp-h-mcp", "plus", "Add server", () => openForm("mcp-edit", {})), seg, null);
    if (v.kind === "machines") return this.frame(t, crumbs([["Machines", reveal("vms")], "All machines"]), act("mp-h-vadd", "plus", "Add machine", () => openForm("vm-add", {})), seg, `${this.machines.length} machine${this.machines.length === 1 ? "" : "s"}`);
    if (v.kind === "settings") return this.frame(t, crumbs(["Settings"]), null, seg, null);
    if (v.kind === "map") return this.frame(t, crumbs(["Map"]), null, seg, shared("mp.mapSub") ?? null);
    return this.frame(t, crumbs(["Tokens & Access"]), act("mp-h-secret", "plus", "Add secret", () => openForm("secret-add", {})), seg, `${this.secrets.length} secret${this.secrets.length === 1 ? "" : "s"}`);
  }

  // One row: breadcrumb (+ status), the meta inline after it, actions and the Workspace / Terminals switch.
  frame(t, crumbs, actions, seg, sub) {
    const collapsed = isCollapsed(LEFT);
    const nav = tabsOf(view()).length > 0;
    return h_flex().id("mp-header").size_full().px(T.sp.xl).gap(T.sp.lg).items_center().bg(t.canvas).text_color(t.foreground)
      .border_b_1().border_color(t.border)
      .when(Boolean(KHs(this).fh), (el) => el.track_focus(KHs(this).fh)).key_context("HvHeader").on_key_down((e, cx) => this.key(e, cx))
      .on_size_change(measure("header"))
      .on_hover((h, cx) => { if (this.hover !== h) { this.hover = h; cx.notify(); } })
      .when(collapsed && window().buttons, (el) => el.child(windowDots(t, this.hover, "mp-h")))
      .child(h_flex().flex_1().min_w(0).gap(T.sp.md).items_center().child(div().flex_none().max_w_full().child(crumbs))
        .when(Boolean(sub), (el) => el.child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(sub))))
      .when(this.kbOn, (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(nav ? "← → view · ↵ open · . actions" : "↵ view · . actions")))
      .when(Boolean(actions), (el) => el.child(actions))
      // Reload: re-reads projects, agents, tasks, machines, secrets everywhere (the views also reload by themselves).
      .child(iconButton(t, "mp-h-reload", "refresh", (_e, cx) => { setShared("mp.reloadAt", Date.now()); toast("Reloaded", "", "info"); cx.notify(); }, "Reload", { size: 26 }))
      .when(Boolean(seg), (el) => el.child(div().flex_none().w(1).h(16).bg(t.border)).child(seg));
  }
}

// ------------------------------------------------------------ terminal tab strip
export class Tabs {
  render() {
    const t = theme();
    const sp = spaces().find((s) => s.active);
    const tabs = sp?.tabs ?? [];
    const item = (c) => h_flex().id(`mp-tab-${c.id}`).flex_none().h(28).px(12).gap(6).rounded(T.r.panel).items_center().cursor_pointer()
      .text_size(T.text.sm).bg(c.active ? t.surface : clear).text_color(c.active ? t.foreground : t.muted)
      .when(c.active, (el) => el.border_1().border_color(t.border))
      .hover((s) => s.bg(c.active ? t.surface : t.hover))
      .on_click(() => run("tab.select", { id: c.id }))
      .when(Boolean(c.status), (el) => el.child(div().size(T.dot).rounded_full().bg(c.status === "working" ? OK : c.status === "blocked" ? WARN : t.dim)))
      .child(c.name)
      .when(c.active, (el) => el.child(h_flex().id(`mp-tab-x-${c.id}`).size(16).rounded(T.r.chip).items_center().justify_center()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
        .child(svg(icon("x")).size(11))));
    return h_flex().id("mp-tabs").size_full().px(4).gap(6).items_center()
      .child(div().flex_none().pr(4).text_size(T.text.xs).font_semibold().text_color(t.dim).child(sp?.name ?? ""))
      .child(h_flex().id("mp-tabs-scroll").flex_1().min_w(0).gap(4).items_center().overflow_x_scroll().children(tabs.map(item)))
      .child(iconButton(t, "mp-tab-new", "plus", () => run("terminal.open", { place: "tab" }), "New terminal"))
      .child(iconButton(t, "mp-tab-back", "layout", () => showCenter("mp-view"), "Back to workspace"));
  }
}

// Shown in the machine terminal block while connecting (or when ssh could not start).
export class VmTermEmpty {
  render() {
    const t = theme();
    const st = shared("mp.vmterm") ?? {};
    const err = st.state === "error";
    return v_flex().id("mp-vmterm-empty").size_full().items_center().justify_center().gap(12).bg(t.background).rounded(T.r.panel)
      .child(h_flex().size(36).rounded(T.r.panel).bg(t.raised).items_center().justify_center()
        .child(svg(icon(err ? "alert" : st.editor ? "layout" : "terminal")).size(17).text_color(err ? "#d57c74" : t.accent).when(!err, (el) => el.loop("opacity", { from: 0.4, to: 1, period: 1200 }))))
      .child(div().text_size(T.text.base).text_color(t.foreground).child(err ? (st.install ? "Neovim is needed for the editor" : st.retry === "key" ? `Could not install the SSH key on ${st.vm}` : st.editor ? `Could not open the editor on ${st.vm}` : `Could not connect to ${st.vm}`) : st.label ?? `Connecting to ${st.vm ?? "machine"}…`))
      .when(err, (el) => el.child(div().max_w(520).text_size(T.text.xs).text_color(t.muted).text_center().whitespace_normal().child(st.err ?? ""))
        .child(h_flex().gap(8)
          .when(Boolean(st.install), (el) => el.child(button(t, "mp-ed-install", "Install Neovim", () => import("./editor.js").then((m) => m.installNvim(st.vm)), { small: true, primary: true, iconName: "plus" })))
          .when(!st.install, (el) => el.child(button(t, "mp-vmterm-retry", "Try Again", () => (st.retry === "key" ? installKey(st.vm) : st.editor ? import("./editor.js").then((m) => m.openEditor(st.vm)) : connectVm(st.vm)), { small: true, primary: true, iconName: "loader" })))
          .when(st.retry !== "key" && !st.install, (el) => el.child(button(t, "mp-vmterm-key", "Install SSH Key", () => installKey(st.vm), { small: true, iconName: "key" })))));
  }
}

// "…" next to the project title: Rename, Regenerate AGENTS.md, Delete (asks twice).
export class ProjectMenu {
  init() { this.p = props() ?? {}; this.confirm = false; }
  render() {
    const t = theme();
    const p = this.p;
    const close = () => closeOverlay(p.overlay);
    const item = (id, ic, label, onClick, danger) => h_flex().id(id).h(32).mx(6).px(12).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
      .text_size(T.text.sm).text_color(danger ? "#d57c74" : t.foreground).hover((s) => s.bg(t.hover))
      .on_click((e, cx) => onClick(e, cx))
      .child(svg(icon(ic)).size(14).text_color(danger ? "#d57c74" : t.muted)).child(label);
    return v_flex().id("mp-pmenu").size_full().py(6).gap(2).bg(t.popover).text_color(t.foreground)
      .child(item("mp-pm-rename", "settings", "Rename & description", () => { close(); openForm("project-edit", { project: p.project, name: p.name, desc: p.desc }); }))
      .child(item("mp-pm-creds", "key", "Project access", () => { close(); openForm("project-secrets", { project: p.project }); }))
      .child(item("mp-pm-docs", "loader", "Regenerate AGENTS.md", (_e, cx) => cx.spawn(async () => {
        const r = await hp(["project", "docs"], { p: p.project });
        toast(r.ok ? "AGENTS.md regenerated" : "Could not regenerate", r.ok ? "" : r.err, r.ok ? "success" : "error");
        close();
      })))
      .child(div().h(1).mx(12).my(4).bg(t.border))
      .child(item("mp-pm-delete", "x", this.confirm ? "Click again to delete" : "Delete project", (_e, cx) => {
        if (!this.confirm) { this.confirm = true; cx.notify(); return; }
        cx.spawn(async () => {
          const r = await hp(["project", "rm"], { p: p.project, confirm: p.project });
          if (!r.ok) { toast("Could not delete project", r.err, "error"); close(); return; }
          const sp = projectSpace({ name: p.name });
          if (sp) run("space.close", { id: sp.id, confirmed: true });
          const rest = (await listProjects()).filter((x) => x.slug !== p.project);
          selectProject(rest[0]?.slug ?? null, "overview");
          toast(`Deleted ${p.name}`, "Moved to ~/.herdr/trash — you can restore it from there.", "success");
          close();
        });
      }, true));
  }
}
