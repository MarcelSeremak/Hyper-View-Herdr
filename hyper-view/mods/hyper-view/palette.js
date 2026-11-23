// Command palette (overlay role "palette", Ctrl+K / F1): jump to anything — projects, tasks, agents,
// machines, secrets, views — or run an action. Linear/Superhuman/Raycast pattern: one input, fuzzy match,
// ↑/↓ + Enter, Esc closes, recent first, and every action shows its shortcut so you learn it.
// Drill-in (Raycast "Show actions", Linear Cmd+K on an item): → or Tab on a row with actions opens its
// action list (actions.js) in place, with a breadcrumb; ← / Backspace on an empty input or Esc goes back.
// Danger actions ask for a second Enter. Props: { drill: ref } opens straight on an entity's actions
// (→ in list views), { mode: "keys" } opens the keyboard shortcuts sheet.
// Actions are also mod commands ("hyper-view.<cmd>" in keys.json, handled in notifier.js), so any of
// them can get a key; the palette reads keys() and shows whatever is bound.
import { keyForAction } from "./lib.js";
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, shared, setShared, keys, run, window as win } from "herdr";
import {
  listProjects, loadProject, loadMachines, loadSecrets, liveAgent, selectProject, openVm, openSecrets, openClipboard, openMailbox, openDashboard,
  showCenter, currentSlug, demo, rememberFocus, iconEl, waitRing, colorFor, tile, startAgent, TASK_EN, WARN, BAD, clear,
} from "./lib.js";
import { openForm } from "./form.js";
import { jumpNextWaiting, openWaiting } from "./attention.js";
import { actionsFor, refLabel } from "./actions.js";
import { SHORTCUTS, runNav } from "./shortcuts.js";

const ROW_H = 30;
const HEAD_H = 24;
const SHOWN = 10;
const LIST_H = SHOWN * ROW_H;
export const PALETTE_H = 8 + 36 + 6 + LIST_H + 4 + 26;

// ------------------------------------------------------------ actions (also mod commands)
const goView = (fn) => () => { fn(); showCenter("mp-view"); };
const firstProject = async () => currentSlug() ?? (await listProjects()).find((p) => !p.loose)?.slug ?? null;
export const ACTIONS = [
  { cmd: "waiting", title: "Jump to next waiting agent", icon: "bell", words: "attention blocked question approval inbox", go: () => jumpNextWaiting() },
  { cmd: "new-project", title: "New project", icon: "plus", words: "create", go: () => openForm("project-new") },
  { cmd: "new-agent", title: "New agent", icon: "bot", words: "create add", go: async () => { const s = await firstProject(); if (s) openForm("agent-new", { project: s }); else openForm("loose-agent", {}); } },
  { cmd: "new-task", title: "New task", icon: "check-square", words: "create add todo issue", go: async () => { const s = await firstProject(); if (s) openForm("task-add", { project: s }); else openForm("project-new"); } },
  { cmd: "add-machine", title: "Add machine", icon: "server", words: "vm ssh host", go: () => openForm("vm-add", {}) },
  { cmd: "add-secret", title: "Add secret", icon: "key", words: "token password credential", go: () => openForm("secret-add", {}) },
  { cmd: "add-skill", title: "New skill", icon: "puzzle", words: "prompt skill create", go: () => openForm("skill-edit", {}) },
  { cmd: "add-mcp", title: "Add MCP server", icon: "plug", words: "mcp tool server create", go: () => openForm("mcp-edit", {}) },
  { cmd: "chat-full", title: "Toggle chat full width", icon: "maximize", words: "conversation expand", go: () => setShared("mp.chatFull", !shared("mp.chatFull")) },
  { cmd: "focus-sidebar", title: "Explorer: Projects", icon: "layers", words: "focus sidebar tree navigate", go: () => runNav("focus-sidebar") },
  { cmd: "explorer-machines", title: "Explorer: Machines", icon: "server", words: "focus sidebar tree vm hosts", go: () => runNav("explorer-machines") },
  { cmd: "explorer-agents", title: "Explorer: Agents", icon: "bot", words: "focus sidebar tree loose", go: () => runNav("explorer-agents") },
  { cmd: "toggle-sidebar", title: "Show / hide explorer", icon: "sidebar", words: "sidebar collapse panel", go: () => runNav("toggle-sidebar") },
  { cmd: "toggle-terminals", title: "Workspace ↔ Terminals", icon: "terminal", words: "terminal shell center", go: () => runNav("toggle-terminals") },
  { cmd: "zone-next", title: "Focus next zone", icon: "compass", words: "f6 focus part region", go: () => runNav("zone-next") },
  { cmd: "focus-chat", title: "Focus chat composer", icon: "messages", words: "chat message type", go: () => runNav("focus-chat") },
  { cmd: "shortcuts", title: "Keyboard shortcuts", icon: "list", words: "keys hotkeys help ? cheat sheet", inline: "keys", go: () => openPaletteWith({ mode: "keys" }) },
  { cmd: "reload", title: "Reload (projects, agents, tasks…)", icon: "refresh", words: "refresh update reload sync", go: () => setShared("mp.reloadAt", Date.now()) },
  { cmd: "demo", title: () => (demo() ? "Turn demo off" : "Turn demo on"), icon: "flask", words: "demo sample data preview", go: () => setShared("mp.demo", !demo()) },
];
const VIEWS = [
  { cmd: "dashboard", title: "Dashboard", icon: "activity", go: goView(openDashboard) },
  { cmd: "mailbox", title: "Mailbox", icon: "inbox", words: "inbox questions", go: goView(openMailbox) },
  { cmd: "tokens", title: "Tokens & Access", icon: "key", words: "secrets credentials passwords keys", go: goView(openSecrets) },
  { cmd: "map", title: "Agent map", icon: "map", words: "ghosts village agents where", go: goView(() => setShared("mp.view", { kind: "map" })) },
  { cmd: "clipboard", title: "Clipboard", icon: "paperclip", words: "notes snippets", go: goView(openClipboard) },
  { cmd: "skills", title: "Skills", icon: "puzzle", words: "prompts skill library attach agent", go: goView(() => setShared("mp.view", { kind: "skills" })) },
  { cmd: "mcp", title: "MCP servers", icon: "plug", words: "mcp tools servers integrations attach agent", go: goView(() => setShared("mp.view", { kind: "mcp" })) },
  { cmd: "settings", title: "Settings", icon: "settings", words: "preferences", key: "ctrl-,", go: () => run("app.settings", {}) },
];
// Runs a palette action / view by its command name (Ctrl+K etc. arrive here via notifier.js).
export function runCommand(c) {
  if (c === "palette") return openPaletteToggle();
  const a = [...ACTIONS, ...VIEWS].find((x) => x.cmd === c);
  if (a) { a.go(); return; }
  runNav(c);
}

// ------------------------------------------------------------ open / toggle
// The view beats a heartbeat while it is open; Esc (closed by Herdr) just stops it.
const paletteOpen = () => globalThis.__hvPal && Date.now() - (globalThis.__hvPalAlive ?? 0) < 1500;
function openWith(extra) {
  rememberFocus("palette");
  import("herdr").then((h) => { globalThis.__hvPalAlive = Date.now(); globalThis.__hvPal = h.openOverlay({ mod: "hyper-view", props: { role: "palette", ...extra }, kind: "dialog", frame: "none", width: extra?.mode === "keys" ? 860 : 560, height: PALETTE_H }); }); // the two-column shortcuts sheet needs room for its labels
}
export function openPaletteToggle() {
  if (paletteOpen()) { try { closeOverlay(globalThis.__hvPal); } catch {} globalThis.__hvPal = null; return; }
  openWith({});
}
// Opens the palette in a given state ({ drill: ref } or { mode: "keys" }), replacing an open one.
export function openPaletteWith(extra) {
  if (paletteOpen()) { try { closeOverlay(globalThis.__hvPal); } catch {} globalThis.__hvPal = null; }
  openWith(extra ?? {});
}

// ------------------------------------------------------------ keys
const mac = () => win()?.platform === "macos";
function keyFor(cmd) {
  const want = `hyper-view.${cmd}`;
  return keyForAction(want);
}
const keyParts = (k) => (k.endsWith("--") ? [...k.slice(0, -2).split("-"), "-"] : k.split("-"))
  .map((p) => ({ ctrl: mac() ? "⌃" : "Ctrl", cmd: "⌘", shift: mac() ? "⇧" : "Shift", alt: mac() ? "⌥" : "Alt", enter: "↵", up: "↑", down: "↓", left: "←", right: "→" }[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))));

// Fuzzy: your letters in order; word starts and runs rank higher (same scoring as Herdr's palette).
function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0, at = 0, runN = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/#]/.test(t[i - 1]);
    runN = i === at && hits.length ? runN + 1 : 0;
    score += 1 + (start ? 6 : 0) + runN * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

function loadRecent() { try { return JSON.parse(globalThis.localStorage?.getItem("hvPalRecent") ?? "null") ?? shared("mp.palRecent") ?? []; } catch { return shared("mp.palRecent") ?? []; } }
function saveRecent(list) { setShared("mp.palRecent", list); try { globalThis.localStorage?.setItem("hvPalRecent", JSON.stringify(list)); } catch {} }

const ORDER = ["Recent", "Waiting", "Actions", "Views", "Projects", "Agents", "Machines", "Tasks", "Secrets"];
// Input wrapper contexts: D = the highlighted row has actions (→ / Tab drill), B = back is possible (← / ⌫).
const CTX = ["HvPalD", "HvPalB", "HvPalDB"];
const drillable = (e) => Boolean(e && (e.ref || e.children || e.inline));

export class Palette {
  init(cx) {
    this.p = props() ?? {};
    this.query = "";
    this.at = 0;
    this.scroll = 0;
    this.items = [];
    this.stack = [];      // drill frames: { title, entries, keys?, at, query }
    this.confirm = null;  // id of a danger entry waiting for its second Enter
    this.recent = loadRecent();
    // Opened straight on a sheet / an entity's actions: say what typing does there.
    this.input = InputState.new({ placeholder: this.p.mode === "keys" ? "Filter shortcuts…" : this.p.drill ? "Filter actions…" : "Jump to or do anything…" });
    this.input.on("change", (_e, cx) => { const v = this.input.value(); if (v !== this.query) { this.query = v; this.at = 0; this.scroll = 0; this.confirm = null; cx.notify(); } });
    this.input.on("submit", (_e, cx) => this.go(this.rows()[this.at]?.e, cx));
    this.input.focus();
    cx.timer.after(250, () => this.input.focus());
    globalThis.__hvPal = this.p.overlay ?? globalThis.__hvPal;
    globalThis.__hvPalAlive = Date.now();
    // Heartbeat while this overlay is the open palette; stops itself once it is closed or replaced.
    const beat = cx.timer.every(500, () => {
      if (this.closed || (this.p.overlay && globalThis.__hvPal !== this.p.overlay)) { try { beat.cancel(); } catch {} return; }
      globalThis.__hvPalAlive = Date.now();
    });
    // The Input's own bindings eat ↑ ↓ Enter → ← Tab Backspace before on_key_down (see chat.js @-popup):
    // bindings for our own contexts, installed once and later than the Input's, win. → / ← / Tab / ⌫ are
    // bound only under the wrapper contexts (CTX), which the input row declares only when they apply,
    // so the caret keys keep working in plain typing.
    if (!globalThis.__hvPalKeys2) {
      try {
        const base = [["up", "hv_pal_up"], ["down", "hv_pal_down"], ["pageup", "hv_pal_pgup"], ["pagedown", "hv_pal_pgdn"], ["enter", "hv_pal_go"], ["escape", "hv_pal_close"]];
        const list = [];
        for (const [keystroke, action] of base) {
          list.push({ keystroke, action, context: "HvPalette > Input" }, { keystroke, action, context: "HvPalette" });
          for (const c of CTX) list.push({ keystroke, action, context: `${c} > Input` });
        }
        for (const c of ["HvPalD", "HvPalDB"]) for (const k of ["right", "tab"]) list.push({ keystroke: k, action: "hv_pal_drill", context: `${c} > Input` });
        for (const c of ["HvPalB", "HvPalDB"]) for (const k of ["left", "backspace"]) list.push({ keystroke: k, action: "hv_pal_back", context: `${c} > Input` });
        list.push({ keystroke: "right", action: "hv_pal_drill", context: "HvPalette" }, { keystroke: "left", action: "hv_pal_back", context: "HvPalette" });
        cx.bind_keys(list);
        globalThis.__hvPalKeys2 = true;
      } catch (err) { console.warn("palette: key bindings", err); }
    }
    cx.spawn(async (cx) => {
      if (this.p.mode === "keys") this.pushKeys();
      else if (this.p.drill) await this.drill({ ref: this.p.drill, title: refLabel(this.p.drill) }, cx);
      cx.notify();
      this.items = await this.load();
      cx.notify();
    });
  }

  close() { this.closed = true; globalThis.__hvPal = null; globalThis.__hvPalAlive = 0; try { closeOverlay(this.p.overlay); } catch {} }

  // Everything you can jump to: views, projects, their agents and open tasks, machines, secrets.
  // Each entity carries a ref: → shows its actions (actions.js).
  async load() {
    const out = [];
    const projects = await listProjects();
    for (const p of projects) {
      if (!p.loose) out.push({ id: `p:${p.slug}`, group: "Projects", title: p.name, sub: `${(p.agents ?? []).length} agents`, tile: { name: p.name, color: p.color }, ref: { kind: "project", slug: p.slug, label: p.name },
        go: () => { selectProject(p.slug, "overview"); showCenter("mp-view"); } });
      const full = await loadProject(p.slug);
      for (const a of full?.agents ?? p.agents ?? []) {
        const live = liveAgent(p, a.name);
        out.push({ id: `a:${p.slug}:${a.name}`, group: "Agents", title: a.name, sub: p.loose ? "loose agent" : p.name, words: a.role ?? "", agent: { name: a.name, live },
          ref: p.loose ? { kind: "loose", slug: p.slug, label: a.name } : { kind: "agent", slug: p.slug, name: a.name },
          go: () => { selectProject(p.slug, p.loose ? "overview" : "agents"); if (!p.loose) setShared("mp.openAgent", { slug: p.slug, name: a.name, at: Date.now() }); showCenter("mp-view"); } });
        if (!p.loose && full) out.push(live
          ? { id: `stop:${p.slug}:${a.name}`, group: "Actions", title: `Stop agent ${a.name}`, sub: p.name, icon: "square", words: "kill", go: () => import("./supervisor.js").then((m) => { m.markManualStop(p.slug, a.name); run("terminal.kill", { terminal: live.address }); }) }
          : { id: `start:${p.slug}:${a.name}`, group: "Actions", title: `Start agent ${a.name}`, sub: p.name, icon: "play", words: "run launch", go: () => startAgent(full, a, undefined, { show: true }) });
      }
      for (const x of full?.tasks ?? []) {
        if (x.status === "done") continue;
        out.push({ id: `t:${p.slug}:${x.id}`, group: "Tasks", title: `#${x.id} ${x.title}`, sub: `${p.name} · ${TASK_EN[x.status] ?? x.status}`, icon: "check-square", words: x.agent ?? "",
          ref: { kind: "task", slug: p.slug, id: x.id },
          go: () => { selectProject(p.slug, "tasks"); import("./taskpanel.js").then((m) => m.openTaskPanel(p.slug, x.id)); showCenter("mp-view"); } });
      }
    }
    for (const m of await loadMachines()) out.push({ id: `m:${m.name}`, group: "Machines", title: m.name, sub: `${m.user ?? ""}@${m.host ?? ""}`, tile: { name: m.name, kind: "vm" }, ref: { kind: "machine", name: m.name },
      go: () => { openVm(m.name); showCenter("mp-view"); } });
    for (const s of await loadSecrets().catch(() => [])) out.push({ id: `s:${s.name}`, group: "Secrets", title: s.name, sub: s.projects?.length ? `${s.projects.length} project${s.projects.length === 1 ? "" : "s"}` : "not shared",
      icon: "key", words: `${s.kind ?? ""} ${s.host ?? ""} secret token`, ref: { kind: "secret", name: s.name }, go: () => { openSecrets(); showCenter("mp-view"); } });
    return out;
  }

  // Static entries + waiting agents, recomputed each render (labels and keys stay live).
  entries() {
    const base = [
      ...(shared("mp.waiting") ?? []).map((w) => ({ id: `w:${w.k}`, group: "Waiting", title: `${w.name}`, sub: `${w.project} · ${w.why === "blocked" ? "waiting for input" : w.why === "approval" ? "needs approval" : "asks you"}`, agent: { name: w.name, live: { status: "blocked" } }, go: () => openWaiting(w), noRecent: true })),
      ...ACTIONS.map((a) => ({ id: `c:${a.cmd}`, group: "Actions", title: typeof a.title === "function" ? a.title() : a.title, icon: a.icon, words: a.words, key: keyFor(a.cmd), go: a.go, inline: a.inline })),
      ...VIEWS.map((a) => ({ id: `v:${a.cmd}`, group: "Views", title: a.title, icon: a.icon, words: a.words, key: a.key ?? keyFor(a.cmd), go: a.go })),
    ];
    return [...base, ...this.items];
  }

  frame() { return this.stack[this.stack.length - 1] ?? null; }

  // Memoized: the overlay re-renders on every shared-state change (agents' status, reloads); the rows only
  // change with the query, the frame, the loaded items, the waiting list or recents.
  rows() {
    const f = this.frame();
    const key = [this.query, f, this.items, shared("mp.waiting"), this.recent.join(",")];
    const m = this._rowsMemo;
    if (m && m.key.every((v, i) => v === key[i]) && Date.now() - m.at < 2000) return m.rows;
    const rows = this.rowsNow(f);
    this._rowsMemo = { key, rows, at: Date.now() };
    return rows;
  }
  rowsNow(f) {
    if (f?.keys) return [];
    const all = f ? f.entries : this.entries();
    const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
    if (f) {
      if (!q) return all.map((e) => ({ e }));
      return all.map((e) => { const m = fuzzy(q, e.title) ?? (fuzzy(q, `${e.title} ${e.sub ?? ""}`) && { score: 0, hits: [] }); return m && { e, score: m.score, hits: m.hits }; })
        .filter(Boolean).sort((a, b) => b.score - a.score);
    }
    if (!q) {
      const recent = this.recent.map((id) => all.find((e) => e.id === id)).filter(Boolean).slice(0, 5);
      const rest = all.filter((e) => !recent.includes(e) && !(e.group === "Actions" && /^(start|stop):/.test(e.id)));
      return [...recent.map((e) => ({ e, head: "Recent" })), ...ORDER.slice(1).flatMap((g) => rest.filter((e) => e.group === g).map((e) => ({ e, head: g })))];
    }
    const rank = (e) => { const i = this.recent.indexOf(e.id); return i < 0 ? 99 : i; };
    return all
      .map((e) => {
        const title = fuzzy(q, e.title);
        const more = fuzzy(q, `${e.group} ${e.title} ${e.sub ?? ""} ${e.words ?? ""}`);
        const best = title ?? (more && { score: more.score - 4, hits: [] });
        return best && { e, score: best.score + (rank(e) < 99 ? 4 - rank(e) * 0.2 : 0), hits: best.hits };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || rank(a.e) - rank(b.e))
      .slice(0, 60);
  }

  // ------------------------------------------------------------ drill-in
  push(fr) {
    this.stack.push({ ...fr, at: this.at, query: this.query });
    this.query = ""; this.input.set_value("");
    this.at = 0; this.scroll = 0; this.confirm = null;
  }
  pushKeys() { this.push({ title: "Keyboard shortcuts", keys: true, entries: [] }); }
  async drill(e, cx) {
    if (!drillable(e) || this.drilling) return;
    if (e.inline === "keys") { this.pushKeys(); cx?.notify(); return; }
    this.drilling = true;
    try {
      const fr = e.children ? await e.children() : await actionsFor(e.ref);
      const entries = (fr?.items ?? []).map((it) => ({ id: `x:${it.id}`, group: fr.title, title: it.title, sub: it.sub, icon: it.icon, tile: it.tile, go: it.go,
        children: it.children, danger: it.danger, on: it.on, noRecent: true }));
      if (!entries.length) entries.push({ id: "x:none", title: "No actions", sub: "", icon: "x", go: null, noRecent: true });
      this.push({ title: fr?.title || e.title, entries, parent: e });
    } finally { this.drilling = false; }
    cx?.notify();
  }
  back(cx) {
    const f = this.stack.pop();
    if (!f) return;
    this.query = f.query ?? ""; this.input.set_value(this.query);
    this.at = f.at ?? 0; this.confirm = null;
    cx.notify();
  }
  // Esc: one level back; opened on a row's actions (→ in a list) or on the shortcuts sheet, Esc at that level closes.
  escape(cx) { if (this.stack.length > ((this.p.drill || this.p.mode) ? 1 : 0)) this.back(cx); else this.close(); }

  go(e, cx) {
    if (!e || Date.now() - (this.wentAt ?? 0) < 250) return;
    if (this.frame()?.keys) return;
    // An entry that only has sub-options (Risk level ▸): Enter opens them.
    if (!e.go && (e.children || e.inline)) { cx?.spawn(async (cx) => this.drill(e, cx)); return; }
    // Enter on "Keyboard shortcuts": reopen as the wide sheet (→ still drills in place).
    if (e.inline === "keys") { openPaletteWith({ mode: "keys" }); return; }
    if (!e.go) return;
    if (e.danger && this.confirm !== e.id) { this.confirm = e.id; cx?.notify(); return; }
    this.wentAt = Date.now();
    if (!e.noRecent) { this.recent = [e.id, ...this.recent.filter((r) => r !== e.id)].slice(0, 20); saveRecent(this.recent); }
    this.close();
    try { const r = e.go(); if (r?.catch) r.catch((err) => console.warn("palette:", err)); } catch (err) { console.warn("palette:", err); }
  }

  move(d, cx) {
    const n = this.rows().length;
    this.at = Math.max(0, Math.min(n - 1, this.at + d));
    this.confirm = null;
    cx.notify();
  }

  titleEl(t, text, hits, on, color) {
    if (!hits?.length) return div().truncate().text_color(color ?? (on ? t.foreground : t.muted)).child(text);
    const parts = [];
    let cur = "", lit = false;
    [...text].forEach((ch, i) => { const h = hits.includes(i); if (h !== lit && cur) { parts.push([cur, lit]); cur = ""; } lit = h; cur += ch; });
    if (cur) parts.push([cur, lit]);
    return h_flex().min_w(0).overflow_hidden().children(parts.map(([s, h]) => div().flex_none().text_color(h ? t.accent : on ? t.foreground : t.muted).when(h, (d) => d.font_semibold()).child(s.replace(/ /g, " "))));
  }

  lead(t, e) {
    if (e.agent) {
      const waiting = e.agent.live?.status === "blocked" || (shared("mp.waiting") ?? []).some((w) => w.name === e.agent.name);
      return h_flex().relative().flex_none().size(18).rounded_full().items_center().justify_center().bg(e.agent.live ? colorFor(`agent:${e.agent.name}`) : "#3a3f47")
        .map(waitRing(18, waiting)).child(iconEl("bot", "#ffffff", 10));
    }
    if (e.tile) return tile(e.tile.name, { kind: e.tile.kind ?? "project", size: 18, color: e.tile.color, radius: 5 });
    return h_flex().flex_none().size(18).items_center().justify_center().child(iconEl(e.icon ?? "chevron-right", e.danger ? BAD : t.dim, 13));
  }

  // The keyboard shortcuts sheet: two compact columns (filtered by the input).
  keysBody(t) {
    const q = this.query.trim().toLowerCase();
    const groups = SHORTCUTS.map(([g, list]) => [g, list.filter(([k, label]) => !q || `${g} ${k} ${label}`.toLowerCase().includes(q))]).filter(([, l]) => l.length);
    const block = ([g, list]) => v_flex().gap(2).pb(8)
      .child(div().h(20).text_size(T.text.xs).font_medium().text_color(t.dim).child(g))
      .children(list.map(([k, label], i) => h_flex().id(`hv-pal-k-${g}-${i}`).h(22).gap(8).items_center().tooltip(`${k}  ${label}`)
        .child(div().w(104).flex_none().truncate().text_size(T.text.xs).font_medium().text_color(t.foreground).child(k))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(label))));
    // Balance the columns by line count.
    const size = (x) => x[1].length + 1;
    const total = groups.reduce((s, x) => s + size(x), 0);
    const left = [], right = [];
    let n = 0;
    for (const g of groups) { (n < total / 2 ? left : right).push(g); n += size(g); }
    return h_flex().id("hv-pal-keys").flex_none().h(LIST_H).px(12).gap(16).items_start().overflow_y_scrollbar()
      .child(v_flex().flex_1().min_w(0).children(left.map(block)))
      .child(v_flex().flex_1().min_w(0).children(right.map(block)))
      .when(!groups.length, (el) => el.child(div().text_size(T.text.sm).text_color(t.dim).child(`Nothing matches "${this.query}".`)));
  }

  render(cx) {
    const t = theme();
    const f = this.frame();
    const rows = this.rows();
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const grouped = !f && !this.query.trim();
    // Fixed-height model (as Herdr's palette): each row/heading at a known y; scroll keeps the selection in view.
    const tops = [];
    let y = 0;
    rows.forEach((r, i) => {
      const head = grouped && (i === 0 || r.head !== rows[i - 1].head);
      tops.push({ head, title: y, row: y + (head ? HEAD_H : 0) });
      y += (head ? HEAD_H : 0) + ROW_H;
    });
    this.maxScroll = Math.max(0, y - LIST_H);
    const sel = tops[this.at];
    if (sel) {
      const from = sel.head ? sel.title : sel.row;
      if (from < this.scroll) this.scroll = from;
      if (sel.row + ROW_H > this.scroll + LIST_H) this.scroll = sel.row + ROW_H - LIST_H;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    const place = (el, a, b) => el.absolute().left(0).right(0).top(a - this.scroll).h(b - a);
    const visible = (a, b) => b > this.scroll && a < this.scroll + LIST_H;
    const chip = (p) => h_flex().flex_none().px(4).h(18).items_center().rounded(T.r.chip).border_1().border_color(t.border).bg(t.raised ?? t.background).text_size(T.text.xs).text_color(t.dim).child(p);
    const list = [];
    rows.forEach((r, i) => {
      const { head, title, row } = tops[i];
      if (head && visible(title, row)) list.push(place(h_flex(), title, row).px(12).pb(4).items_end().text_size(T.text.xs).font_medium().text_color(t.dim).child(r.head));
      if (!visible(row, row + ROW_H)) return;
      const on = i === this.at;
      const e = r.e;
      const sure = this.confirm === e.id;
      const canDrill = drillable(e);
      list.push(place(h_flex(), row, row + ROW_H).id(`hvpl-${i}`).mx(4).px(8).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
        .bg(on ? (sure ? `${BAD}22` : t.selected) : clear).hover((s) => s.bg(on ? (sure ? `${BAD}22` : t.selected) : t.hover))
        .on_click((_e, cx) => { if (this.at !== i && e.danger) { this.at = i; } this.go(e, cx); })
        .child(this.lead(t, e))
        .child(h_flex().flex_1().min_w(0).gap(8).items_center().text_size(T.text.base)
          .child(div().flex_shrink(1).min_w(0).child(sure
            ? div().truncate().text_color(BAD).font_medium().child(`Press Enter again: ${e.title.toLowerCase()}`)
            : this.titleEl(t, e.title, r.hits, on, e.danger && on ? BAD : null)))
          .when(Boolean(e.sub) && !sure, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(e.sub))))
        .when(Boolean(e.on), (el) => el.child(iconEl("check", t.accent, 13)))
        .when(!grouped && !f, (el) => el.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(e.group)))
        .when(Boolean(e.key) && !(on && canDrill), (el) => el.child(h_flex().flex_none().gap(2).children(keyParts(e.key).map(chip))))
        // Raycast-style hint: this row has more (→ actions / → options).
        .when(canDrill && on, (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(T.text.xs).text_color(t.dim)
          .child(chip("→")).child(div().child(e.ref ? "actions" : e.inline ? "open" : "options"))))
        .when(canDrill && !on && !e.ref, (el) => el.child(iconEl("chevron-right", t.dim, 12))));
    });
    const waitKey = keyFor("waiting");
    const nWait = (shared("mp.waiting") ?? []).length;
    const cur = rows[this.at]?.e;
    const back = this.stack.length > 0 && !this.query;
    const ctx = drillable(cur) && !f?.keys ? (back ? "HvPalDB" : "HvPalD") : back ? "HvPalB" : null;
    // Breadcrumb: "web-frontend-01 ›" per drill level (Raycast/Linear: the item you act on stays visible).
    const crumbs = this.stack.map((s) => s.title);
    const inputRow = h_flex().flex_none().h(36).px(10).gap(8).items_center().rounded(T.r.panel).bg(t.background).border_1().border_color(t.accent)
      .when(Boolean(ctx), (el) => el.key_context(ctx))
      .child(iconEl(f ? "chevron-left" : "search", t.dim, 14))
      .children(crumbs.map((c, i) => h_flex().id(`hv-pal-crumb-${i}`).flex_none().max_w(170).h(22).px(6).gap(4).items_center().rounded(T.r.chip).bg(t.raised ?? t.hover).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { while (this.stack.length > i + 1) this.stack.pop(); this.back(cx); })
        .child(div().min_w(0).truncate().text_size(T.text.xs).font_medium().text_color(t.foreground).child(c)).child(div().text_size(T.text.xs).text_color(t.dim).child("›"))))
      .child(Input.new(this.input).flex_1().h_full().text_size(T.text.base).text_color(t.foreground))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(f ? "Esc back" : "Esc"));
    const footer = h_flex().flex_none().h(24).px(6).gap(12).items_center().border_t_1().border_color(t.border).text_size(T.text.xs).text_color(t.dim)
      .child(div().child("↑↓ move"))
      .child(div().child(f?.keys ? "type to filter" : "↵ open"))
      .when(!f?.keys, (el) => el.child(div().child("→ actions")))
      .when(this.stack.length > 0, (el) => el.child(div().child("← back")))
      .child(div().child("esc close"))
      .child(div().flex_1())
      .when(!f && nWait > 0, (el) => el.child(h_flex().gap(4).items_center()
        .child(div().size(T.dot).rounded_full().bg(WARN))
        .child(div().text_color(WARN).child(`${nWait} waiting`))
        .when(Boolean(waitKey), (el) => el.child(div().child(`· ${keyParts(waitKey).join(" ")} to jump`)))))
      .when(!f && !nWait, (el) => el.child(div().child("Ctrl / shortcuts")));
    return v_flex().id("hv-palette").key_context("HvPalette").size_full().p(8).gap(6).bg(t.popover ?? t.surface).rounded(T.r.dialog + 2).border_1().border_color(t.border)
      .on_action("hv_pal_up", (_e, cx) => this.move(-1, cx))
      .on_action("hv_pal_down", (_e, cx) => this.move(1, cx))
      .on_action("hv_pal_pgup", (_e, cx) => this.move(-SHOWN, cx))
      .on_action("hv_pal_pgdn", (_e, cx) => this.move(SHOWN, cx))
      .on_action("hv_pal_go", (_e, cx) => this.go(this.rows()[this.at]?.e, cx))
      .on_action("hv_pal_drill", (_e, cx) => { const e = this.rows()[this.at]?.e; cx.spawn(async (cx) => this.drill(e, cx)); })
      .on_action("hv_pal_back", (_e, cx) => { if (!this.query) this.back(cx); })
      .on_action("hv_pal_close", (_e, cx) => this.escape(cx))
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { this.escape(cx); cx.stop_propagation(); return; }
        if (k === "down") this.move(1, cx); else if (k === "up") this.move(-1, cx); else return;
        cx.stop_propagation();
      })
      .child(inputRow)
      .child(f?.keys
        ? this.keysBody(t)
        : rows.length
          ? div().id("hv-palette-rows").relative().flex_none().h(LIST_H).overflow_hidden()
            .on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, this.maxScroll));
              while (this.at < rows.length - 1 && (tops[this.at].head ? tops[this.at].title : tops[this.at].row) < this.scroll) this.at++;
              while (this.at > 0 && tops[this.at].row + ROW_H > this.scroll + LIST_H) this.at--;
              cx.notify();
            })
            .children(list)
          : div().flex_none().h(LIST_H).px(12).py(8).text_size(T.text.sm).text_color(t.dim).child(f && !this.query ? "Loading…" : `Nothing matches "${this.query}".`))
      // Footer: the keys of the palette itself, and one tip (Superhuman: teach the shortcut).
      .child(footer);
  }
}
