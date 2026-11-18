// Keyboard map of hyper-view: the "Keyboard shortcuts" sheet (palette, ? / Ctrl+/) and the global
// navigation commands bound in keys.json ("hyper-view.<cmd>", delivered via notifier.js → palette.runCommand).
// Patterns: VS Code (F6 / Shift+F6 cycle the workbench parts, Ctrl+Shift+E explorer, Ctrl+Tab tabs, Ctrl+`
// terminal, F1 palette), WAI-ARIA APG tree view and tabs (arrows, Home/End, type-ahead), Linear (G then a
// letter, J/K lists, Ctrl+K), Raycast (→ shows an item's actions).
import { shared, setShared, run, spaces, panes } from "herdr";
import { view, openTab, listProjects, selectProject, openProjectSpace, showCenter, currentSlug, centerShown } from "./lib.js";

export const SHORTCUTS = [
  ["Anywhere", [
    ["Ctrl K  F1", "Command palette (F1 also in terminals)"],
    ["F6  ⇧F6", "Next / previous zone: activity bar · explorer · header · view · chat · status bar"],
    ["Ctrl J", "Next waiting agent"],
    ["Alt 1–6", "Project: Overview · Agents · Tasks · Epics · Machines · Activity (machine: Alt 1–3 Overview · Editor · Access)"],
    ["Ctrl Tab  Ctrl ⇧ Tab", "Next / previous project view (terminal tabs on the Terminals view)"],
    ["Ctrl ⇧ ↑ ↓", "Previous / next project"],
    ["Ctrl ⇧ E", "Projects + explorer (again: back to the view)"],
    ["Ctrl ⇧ H", "Machines + explorer"],
    ["Ctrl ⇧ G", "Agents (all, loose ones too) + explorer"],
    ["Ctrl ⇧ B", "Show / hide the explorer"],
    ["Ctrl `", "Workspace ↔ Terminals"],
    ["Ctrl ⇧ D", "Dashboard"],
    ["Ctrl ⇧ M", "Mailbox"],
    ["Ctrl ⇧ A", "Tokens & Access"],
    ["Ctrl ,", "Settings"],
    ["Ctrl F", "Search in the view, else filter the explorer"],
    ["Ctrl /", "This sheet"],
  ]],
  ["Explorer tree", [
    ["↑ ↓", "Move"],
    ["→", "Expand · first child · actions on a leaf"],
    ["←", "Collapse · parent · activity bar"],
    ["Home End  PgUp PgDn", "First / last / page"],
    ["a–z", "Type-ahead: jump to the next row starting with it"],
    ["/", "Filter (↓ into the tree, Enter opens the first match, Esc clears)"],
    ["Enter", "Open and go to the view"],
    ["Space", "Open, stay in the tree"],
    ["*", "Expand all siblings"],
    [".  ⇧F10", "Actions for the row"],
    ["+", "New item in this section"],
    ["Esc", "Clear filter · back to the view"],
  ]],
  ["Activity bar · header · status bar", [
    ["↑ ↓", "Activity bar: move (Enter switches mode, → explorer)"],
    ["← →", "Header: previous / next project view · status bar: move"],
    ["1–6  Home End", "Header: pick a project view"],
    ["Enter  ↓", "Header: into the view · status bar: run the entry"],
    [".", "Header: actions for this project / machine / agent"],
  ]],
  ["Lists (focused view)", [
    ["J K  ↑ ↓", "Move"],
    ["Enter", "Open"],
    ["→", "Actions for the row"],
    ["← →", "Board: column"],
    ["A  E", "Approve (dashboard) · done / edit (mailbox, clipboard)"],
    ["C", "Chat composer"],
    ["G D·M·T·S·C", "Go to Dashboard, Mailbox, Tokens, Settings, Clipboard"],
    ["G K·I", "Go to Skills, MCP servers"],
    ["G P·V·A", "Explorer: Projects, Machines, Agents"],
    ["/", "Search"],
    ["?", "This sheet"],
    ["Esc", "Close panel / detail · up to the explorer"],
  ]],
  ["Palette", [
    ["↑ ↓", "Move"],
    ["Enter", "Open / run"],
    ["→  Tab", "Actions"],
    ["←  ⌫", "Back (empty input)"],
    ["Esc", "Back / close"],
  ]],
  ["Chat · forms", [
    ["Enter  Ctrl Enter", "Send"],
    ["@", "Ask one agent"],
    ["A  R  W", "Question to you (hovered / selected): approve · reject · wait"],
    ["↑ ↓  Enter", "Chat messages: move between questions · reply"],
    ["Tab  ⇧Tab", "Forms: next / previous field"],
    ["Enter  Esc", "Forms: submit / cancel"],
  ]],
];

const PROJECT_TABS = ["overview", "agents", "tasks", "epics", "machines", "activity"];
const VM_TABS = ["overview", "editor", "access"];

// Asks a part to take the keyboard: "activity", "sidebar" (explorer), "header" (tab bar), "view", "chat",
// "status", or "find" (the view's search, else the explorer filter). extra: { reveal: section }.
export function focusTo(to, extra) {
  if (to === "view" && centerShown() !== "mp-view" && focusTerminal()) { globalThis.__hvZone = "view"; return; }
  globalThis.__hvZone = to === "find" || to === "filter" ? "sidebar" : to;
  setShared("mp.focus", { to, at: Date.now(), ...(extra ?? {}) });
}
// The center shows terminals: put the keyboard into the active terminal instead of the hidden view.
function focusTerminal() {
  try {
    const sp = spaces().find((s) => s.active);
    const tab = sp?.tabs?.find((x) => x.active);
    const ps = panes().filter((p) => p.terminal && (!tab || p.tab === tab.id));
    const p = ps.find((x) => x.focused) ?? ps[0];
    if (!p) return false;
    run("pane.focus", { pane: p.pane });
    return true;
  } catch { return false; }
}

// F6 / Shift+F6 zones, VS Code "Focus Next Part" order. The explorer is skipped while it is collapsed.
export const ZONES = ["activity", "sidebar", "header", "view", "chat", "status"];
function currentZone() {
  const fh = globalThis.__hvFH ?? {};
  for (const z of ZONES) { try { if (fh[z]?.is_focused()) return z; } catch {} }
  return globalThis.__hvZone ?? "view";
}
function cycleZone(d) {
  let i = ZONES.indexOf(currentZone());
  if (i < 0) i = ZONES.indexOf("view");
  for (let n = 0; n < ZONES.length; n++) {
    i = (i + d + ZONES.length) % ZONES.length;
    if (ZONES[i] === "sidebar" && shared("mp.leftCollapsed")) continue;
    break;
  }
  focusTo(ZONES[i]);
}
const explorer = (sec) => { setShared("mp.explorer", sec); focusTo("sidebar", { reveal: sec }); };

// Global navigation commands. Answers true when it knew the command.
export function runNav(c) {
  let m;
  if ((m = /^tab-(\d)$/.exec(c))) { tab(Number(m[1]) - 1); return true; }
  if (c === "tab-next" || c === "tab-prev") {
    const d = c === "tab-next" ? 1 : -1;
    if (centerShown() === "mp-terms") run(d > 0 ? "tab.next" : "tab.prev");
    else import("./toolbar.js").then((t) => t.stepTab(d));
    return true;
  }
  if (c === "zone-next" || c === "zone-prev") { cycleZone(c === "zone-next" ? 1 : -1); return true; }
  if (c === "project-next" || c === "project-prev") { stepProject(c === "project-next" ? 1 : -1); return true; }
  if (c === "focus-sidebar") {
    if (globalThis.__hvSideFocus) focusTo("view");
    else { if (shared("mp.explorer") && shared("mp.explorer") !== "projects") setShared("mp.explorer", null); focusTo("sidebar", { reveal: "projects" }); }
    return true;
  }
  if (c === "explorer-projects") { explorer("projects"); return true; }
  if (c === "explorer-machines") { explorer("vms"); return true; }
  if (c === "explorer-agents") { explorer("agents"); return true; }
  if (c === "focus-activity") { focusTo("activity"); return true; }
  if (c === "focus-tabs") { focusTo("header"); return true; }
  if (c === "focus-chat") { focusTo("chat"); return true; }
  if (c === "focus-status") { focusTo("status"); return true; }
  if (c === "toggle-sidebar") {
    // The sidebar copy runs the animated resize (it needs a view context): shared "mp.toggleLeft".
    if (!shared("mp.leftCollapsed") && globalThis.__hvSideFocus) focusTo("view");
    setShared("mp.toggleLeft", Date.now());
    return true;
  }
  if (c === "toggle-terminals") { showCenter(centerShown() === "mp-terms" ? "mp-view" : "mp-terms"); if (centerShown() === "mp-terms") focusTerminal(); return true; }
  if (c === "focus-view") { focusTo("view"); return true; }
  if (c === "find") { focusTo("find"); return true; }
  if (c === "close-panel") { if (shared("mp.taskPanel")) setShared("mp.taskPanel", null); return true; }
  return false;
}

function tab(i) {
  const v = view();
  if (v.kind === "vm") {
    const k = VM_TABS[i];
    if (!k) return;
    if (k === "editor") { openTab("editor"); import("./editor.js").then((e) => e.openEditor(v.name)); return; }
    openTab(k); showCenter("mp-view");
    return;
  }
  const k = PROJECT_TABS[i];
  if (!k) return;
  if (v.kind === "project" && v.slug) {
    // Agents mode (loose agents, agents opened from Agents) has no project views.
    import("./toolbar.js").then((tb) => { if (tb.tabsOf(v).length) tb.pickTab(k); });
    return;
  }
  const slug = currentSlug();
  if (slug) { selectProject(slug, k); showCenter("mp-view"); return; }
  listProjects().then((all) => { const p = all.find((x) => !x.loose); if (p) { selectProject(p.slug, k); showCenter("mp-view"); } });
}

async function stepProject(d) {
  const all = (await listProjects()).filter((p) => !p.loose);
  if (!all.length) return;
  const v = view();
  const i = v.kind === "project" ? all.findIndex((p) => p.slug === v.slug) : -1;
  const next = all[i < 0 ? (d > 0 ? 0 : all.length - 1) : (i + d + all.length) % all.length];
  selectProject(next.slug, v.kind === "project" ? v.tab ?? "overview" : "overview");
  openProjectSpace(next);
  showCenter("mp-view");
}
