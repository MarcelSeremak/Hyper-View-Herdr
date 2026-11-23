// Shared by every part of the hyper-view layout: paths, hp calls, data loading,
// navigation, design tokens and small UI building blocks.
import { T } from "./tokens.js";
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Scrollbar } from "gpui-base";
import { exec, home, appHome, readTextFile, shared, setShared, agents, spaces, panes, run, notify, watchFolder, hc, layout, writeTextFile, keys, window as hwin } from "herdr";
import * as fs from "fs/promises";
import { DEMO_MACHINES, DEMO_STATS, DEMO_PROJECT, DEMO_EVENTS, DEMO_LIVE, DEMO_SECRETS, DEMO_USES, DEMO_LOOSE, DEMO_LOOSE_EVENTS, DEMO_LOCKS, demoBigProject, demoMachines, demoStats, DEMO_MANY_LOCKS } from "./demo.js";

// Design preview mode (set by the dev bridge): in-memory demo data, nothing on disk.
export const demo = () => Boolean(shared("mp.demo"));
// Live sizes of the layout's parts (filled by on_size_change in each part; the chat reads the sidebar's width).
export const rects = () => (globalThis.__hvRects ??= {});
export const measure = (key) => (size) => { rects()[key] = { w: size.width, h: size.height }; };

export const MOD = "hyper-view";
export const icon = (name) => `mods/${MOD}/icons/${name}.svg`;
const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const herdrHome = () => `${slash(home())}/.herdr`;
export const projectsRoot = () => `${herdrHome()}/projects`;
export const projectDir = (slug) => `${projectsRoot()}/${slug}`;
export const hpScript = () => `${slash(appHome())}/mods/${MOD}/hp.ps1`;
export const hpCmd = () => `${herdrHome()}/bin/hp.cmd`.replace(/\//g, "\\");
export const sshAlias = (vm) => `herdr-${vm}`;
const winPath = (p) => String(p).replace(/\//g, "\\");

// ------------------------------------------------------------ navigation
// shared("mp.view"): { kind: "project", slug, tab } | { kind: "vm", name, tab } | { kind: "secrets" } | { kind: "settings" }
// | { kind: "dashboard" } (global overview; the start view when no project is open)
export const view = () => shared("mp.view") ?? (shared("mp.project") ? { kind: "project", slug: shared("mp.project"), tab: "overview" } : { kind: "dashboard" });
// The project whose conversation and data are shown: the open project, else the last one opened.
export const currentSlug = () => { const v = shared("mp.view"); return (v?.kind === "project" && v.slug) || (shared("mp.project") ?? null); };
export function selectProject(slug, tab) {
  setShared("mp.project", slug);
  const v = view();
  setShared("mp.view", { kind: "project", slug, tab: tab ?? (v.kind === "project" ? v.tab : null) ?? "overview" });
}
export const openTab = (tab) => setShared("mp.view", { ...view(), tab });

// ------------------------------------------------------------ focus manager (overlays)
// A dialog, the palette, a popover or the project menu takes the keyboard; when it goes, nothing in the main
// window has it any more and keys do nothing until a click. So every overlay open remembers the F6 zone that
// had the keyboard (activity, sidebar, header, view, chat, status; the row inside a zone is kept by the zone
// itself: explorer kbSel, view navSel, header tab, chat composer) and every close path gives it back:
// overlay copies from their close() hook (main.js: submit, Enter, Esc, Cancel, outside click, overlay.close),
// popovers from on_open_change(false) / their pick. The give-back runs a beat later from a long-lived copy
// (pumpFocus in the sidebar's render), and only when no other overlay of ours is still open and nothing asked
// for the keyboard meanwhile (a palette command such as "Explorer: Agents", or a form opening a panel, wins).
const FOCUS_ZONES = ["activity", "sidebar", "header", "view", "chat", "status"];
const FOCUS_DELAY = 90; // ms: lets the overlay's copy go and a follow-up overlay (palette → form) open first
const fm = () => (globalThis.__hvFocusMem ??= { zone: null, at: 0, open: [], pending: null, log: [] });
const fmLog = (m, s) => { m.log.push(`${new Date().toISOString().slice(11, 23)} ${s}`); if (m.log.length > 12) m.log.shift(); };
// The zone whose focus handle has the keyboard now (handles registered in globalThis.__hvFH), else null.
export function focusedZone() {
  const fh = globalThis.__hvFH ?? {};
  for (const z of FOCUS_ZONES) { try { if (fh[z]?.is_focused()) return z; } catch {} }
  return null;
}
// Call right before opening an overlay or a popover. An overlay opened from another one (palette → form)
// keeps the zone from before the first.
export function rememberFocus(what) {
  const m = fm();
  const z = focusedZone();
  m.open = m.open.filter((x) => Date.now() - x.seen < 60000);
  if (z || !m.open.length) m.zone = z ?? globalThis.__hvZone ?? "view";
  m.at = Date.now();
  m.pending = null;
  fmLog(m, `remember ${what ?? ""} → ${m.zone}`);
}
// Overlay copies report themselves (main.js init / render / close). `seen` is bumped on every render of the
// copy: restoreFocus re-renders every live copy, so an entry not seen since (a copy dropped by a hot reload
// without its close()) is stale and does not block the give-back.
export function overlayOpened(id) { const m = fm(); if (id && !m.open.some((x) => x.id === id)) m.open.push({ id, seen: Date.now() }); }
export function overlaySeen(id) { const x = fm().open.find((o) => o.id === id); if (x) x.seen = Date.now(); }
export function overlayClosed(id, what) { const m = fm(); m.open = m.open.filter((x) => x.id !== id); restoreFocus(what ?? "overlay"); }
// Asks for the remembered zone back (idempotent; the long-lived copies do it in pumpFocus).
export function restoreFocus(why) {
  const m = fm();
  m.pending = { why: why ?? "", at: Date.now() };
  fmLog(m, `restore? ${why ?? ""}`);
  setShared("mp.focusRestore", m.pending.at); // re-renders every copy, so pumpFocus runs
}
export function pumpFocus(cx) {
  const m = fm();
  const p = m.pending;
  if (!p || p.timer) return;
  p.timer = true;
  cx.timer.after(FOCUS_DELAY, (cx) => {
    if (m.pending !== p) return;
    m.pending = null;
    m.open = m.open.filter((x) => x.seen >= p.at || Date.now() - x.seen < 2000);
    if (m.open.length) { fmLog(m, `skip: still open ${m.open.map((x) => x.id).join(",")}`); return; }
    const fr = shared("mp.focus");
    if (fr?.at > m.at && fr.by !== "restore") { fmLog(m, `skip: focus asked (${fr.to})`); return; }
    let z = m.zone ?? globalThis.__hvZone ?? "view";
    if (z === "sidebar" && shared("mp.leftCollapsed")) z = "view";         // explorer folded since
    if (z === "chat" && (shared("mp.chatHidden") || shared("mp.rightCollapsed"))) z = "view";
    if (focusedZone() === z) { fmLog(m, `ok: ${z} already focused`); return; }
    // The main window back to the front when an overlay window had the platform focus.
    try { const w = globalThis.window; if (w?.is_window_active && !w.is_window_active()) w.activate_window(); } catch {}
    fmLog(m, `→ ${z}`);
    import("./shortcuts.js").then((s) => s.focusTo(z, { by: "restore" })).catch(() => {});
    cx.notify();
  });
}
// Popover helper: on_open_change(o) → popFocus(o).
export const popFocus = (o, what = "popover") => (o ? rememberFocus(what) : restoreFocus(what));
// For the dev bridge.
export function focusDebug() {
  const m = fm();
  return { focused: focusedZone(), hvZone: globalThis.__hvZone ?? null, remembered: m.zone, open: m.open.map((x) => x.id), pending: m.pending, log: [...m.log],
    handles: Object.keys(globalThis.__hvFH ?? {}), windowActive: (() => { try { return globalThis.window?.is_window_active?.() ?? null; } catch (e) { return String(e?.message ?? e); } })() };
}
export const openVm = (name, tab = "overview") => setShared("mp.view", { kind: "vm", name, tab });
export const openSecrets = () => setShared("mp.view", { kind: "secrets" });
export const openSettings = () => setShared("mp.view", { kind: "settings" });
export const openClipboard = () => setShared("mp.view", { kind: "clipboard" });
export const openMailbox = () => setShared("mp.view", { kind: "mailbox" });
export const openDashboard = () => setShared("mp.view", { kind: "dashboard" });
// Command palette (Ctrl+K; again closes). Lazy import: palette.js imports this file.
export const openPalette = () => import("./palette.js").then((m) => m.openPaletteToggle());
// An agent that needs you: live "blocked" or an open question/approval (attention.js publishes mp.waiting).
// shared() copies the whole value out of the host on every call. Values read in render loops (every avatar,
// every machine row) are kept for 250 ms: mp.vmstats alone is ~20 KB, read dozens of times per frame.
const SHC = (globalThis.__hvSharedCache ??= {});
export function sharedFast(key) {
  const c = SHC[key], n = Date.now();
  if (c && n - c.at < 250) return c.v;
  const v = shared(key);
  SHC[key] = { at: n, v };
  return v;
}
export const isWaiting = (name, live) => live?.status === "blocked" || (sharedFast("mp.waiting") ?? []).some((w) => w.name === name);
export function showCenter(child) {
  run("layout.select", { stack: "mp-center", child });
  setShared("mp.center", child);
}
export const centerShown = () => shared("mp.center") ?? "mp-view";

// ------------------------------------------------------------ base64 (UTF-8)
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function utf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
export function b64(str) {
  const b = utf8(String(str));
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return s;
}

// ------------------------------------------------------------ hp (PowerShell)
export async function hp(positional, options = {}, timeout = 60000) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hpScript()];
  for (const p of positional) args.push("b64:" + b64(p));
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined || v === null || v === false) continue;
    args.push(`--${k}`);
    if (v !== true) args.push("b64:" + b64(Array.isArray(v) ? v.join(",") : String(v)));
  }
  try {
    const r = await exec("powershell.exe", args, { timeout });
    return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || "").replace(/^hp: /, "").trim() || (r.code ? `exit code ${r.code}` : "") };
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}
let installing = null;
export function ensureInstalled() { installing ??= hp(["install"]); return installing; }

// ------------------------------------------------------------ data
const parse = (text, fallback) => {
  if (!text) return fallback;
  try { return JSON.parse(text.replace(/^﻿/, "")); } catch { return fallback; }
};
// readTextFile reads at most 1 MiB: a bigger file (or one near that size) is read again with fs.
// hp keeps the files it writes below that (compact tasks.json, trimmed events.jsonl); this is the safety net.
export async function readBig(path) {
  const t = await readTextFile(path).catch(() => undefined);
  if (t === null) return null;
  // Complete when short, or when it ends like a whole file (hp ends jsonl with "\n", JSON with } or ]).
  if (t !== undefined && (t.length < 340000 || /[\n}\]]\s*$/.test(t.slice(-4)))) return t;
  return fs.readFile(path, "utf8").catch(() => t ?? null);
}
export async function readJson(path, fallback) { return parse(await readBig(path), fallback); }
export const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
function jsonl(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
export async function loadMachines() {
  if (demo()) return demoMachines(); // 80 with shared "mp.demoMany"
  return arr(await readJson(`${herdrHome()}/machines.json`, [])).sort((a, b) => a.name.localeCompare(b.name));
}
export async function loadSecrets() {
  if (demo()) return DEMO_SECRETS;
  return arr(await readJson(`${herdrHome()}/secrets.json`, [])).map((s) => ({ ...s, projects: arr(s.projects), agents: arr(s.agents) }));
}
// Machine locks (hp lock): ~/.herdr/locks.json. loadLocks() also caches them for lockOf() (sync, for rendering).
export async function loadLocks() {
  const list = demo() ? (shared("mp.demoMany") ? [...DEMO_LOCKS, ...DEMO_MANY_LOCKS] : DEMO_LOCKS) : arr(await readJson(`${herdrHome()}/locks.json`, []));
  setSharedIf("mp.locks", list);
  return list;
}
// setShared only when the value really changed (every setShared re-renders every mod and rewrites
// shared.json). `skip`: keys ignored in the comparison (timestamps like "at"/"checked"), at any depth.
export function setSharedIf(key, value, skip = []) {
  const norm = (v) => JSON.stringify(v ?? null, skip.length ? (k, x) => (skip.includes(k) ? undefined : x) : undefined);
  if (norm(shared(key)) === norm(value)) return false;
  setShared(key, value);
  return true;
}
export function lockOf(vm) {
  const l = arr(sharedFast("mp.locks")).find((x) => x.vm === vm); // read per machine row: cached copy
  return l && new Date(l.expires).getTime() > Date.now() ? l : null;
}
export const lockTip = (l) => `Locked by ${l.owner}${l.project ? ` (${l.project})` : ""} until ${fmtTime(l.expires)}: ${l.reason}`;
export async function loadSecretUses() {
  if (demo()) return DEMO_USES;
  return jsonl(await readBig(`${herdrHome()}/secret-uses.jsonl`)).slice(-500);
}
export async function listProjects() {
  if (demo()) return [...DEMO_LOOSE, DEMO_PROJECT, { ...DEMO_PROJECT, name: "AI Research", slug: "demo-ai", color: "#6f9fd0", status: "active", agents: [] }, { ...DEMO_PROJECT, name: "DevOps Tools", slug: "demo-devops", color: "#c98a62", agents: [] }, { ...DEMO_PROJECT, name: "Data Pipeline", slug: "demo-data", color: "#5fa89a", agents: [] }];
  let names = [];
  try { names = await fs.readdir(projectsRoot()); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const dir = projectDir(n);
    const p = await readJsonCached(`${dir}/project.json`, null);
    if (!p) continue;
    const agentList = arr(await readJsonCached(`${dir}/agents.json`, [])).map((a) => ({ ...a }));
    out.push({ ...p, slug: n, machines: arr(p.machines).slice(), agents: agentList });
  }
  return out;
}
export async function loadProject(slug) {
  if (!slug) return null;
  if (demo()) return slug === DEMO_PROJECT.slug ? (shared("mp.demoBig") ? demoBigProject() : DEMO_PROJECT) :DEMO_LOOSE.find((x) => x.slug === slug) ?? { ...DEMO_PROJECT, slug, name: slug, agents: [], tasks: [] };
  const dir = projectDir(slug);
  const p = await readJsonCached(`${dir}/project.json`, null);
  if (!p) return null;
  const tasks = (await readJsonCached(`${dir}/tasks.json`, null)) ?? { tasks: [] };
  const agentList = arr(await readJsonCached(`${dir}/agents.json`, [])).map((a) => ({ ...a, machines: arr(a.machines).slice() }));
  // Team memory summary written by hp (counts per kind + newest titles); null until something is remembered.
  const memory = await readJson(`${dir}/memory.json`, null);
  return {
    ...p, slug, dir, machines: arr(p.machines).slice(), agents: agentList, memory,
    tasks: arr(tasks.tasks).map((x) => ({ ...x, notes: arr(x.notes).slice(), history: arr(x.history).slice(), priority: x.priority ?? "normal", progress: x.progress ?? 0 })),
  };
}
export async function loadEvents(slug) {
  if (!slug) return [];
  if (demo()) return slug === DEMO_PROJECT.slug ? DEMO_EVENTS : DEMO_LOOSE_EVENTS[slug] ?? [];
  return (await eventsCached(`${projectDir(slug)}/events.jsonl`)).slice();
}
// Every view reloads after each change under ~/.herdr; with a dozen agents writing events.jsonl that meant the
// same 0.5 MB file read and JSON-parsed by several views every few seconds on the UI thread. One shared cache:
// reads in flight are shared (1 s), unchanged text returns the parsed list, appended text parses only the tail.
const EVC = (globalThis.__hvEvCache ??= new Map());
function eventsCached(path) {
  const c = EVC.get(path);
  if (c?.p && Date.now() - c.at < 1000) return c.p;
  const p = (async () => {
    const text = (await readBig(path)) ?? "";
    // Only a fingerprint (length + last 256 chars) is kept, not the text: mods have a small memory and a full
    // heap is what makes renders run out of time ("could not be re-rendered").
    const old = EVC.get(path);
    const tail = text.slice(-256);
    let list;
    if (old?.list && old.len === text.length && old.tail === tail) list = old.list;
    else if (old?.list && text.length > old.len && old.tail.endsWith("\n") && text.slice(old.len - old.tail.length, old.len) === old.tail) list = old.list.concat(jsonl(text.slice(old.len)));
    else list = jsonl(text);
    EVC.set(path, { ...EVC.get(path), len: text.length, tail, list });
    return list;
  })();
  EVC.set(path, { ...(c ?? {}), p, at: Date.now() });
  return p.catch(() => c?.list ?? []);
}
// Length + FNV-1a hash of a text (outside render; ~1 ms per 100 KB).
function fingerprint(text) {
  const s = String(text ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${s.length}:${h >>> 0}`;
}
// Same idea for JSON files every view reads (tasks.json, agents.json, project.json, machines.json…).
const JSC = (globalThis.__hvJsonCache ??= new Map());
export async function readJsonCached(path, fallback) {
  const c = JSC.get(path);
  if (c?.p && Date.now() - c.at < 1000) return (await c.p.catch(() => undefined)) ?? fallback;
  const p = readBig(path).then((text) => {
    const old = JSC.get(path);
    const fp = fingerprint(text);
    if (old?.fp === fp && old.val !== undefined) return old.val;
    const val = parse(text, undefined);
    JSC.set(path, { ...JSC.get(path), fp, val });
    return val;
  });
  JSC.set(path, { ...(c ?? {}), p, at: Date.now() });
  return (await p.catch(() => undefined)) ?? fallback;
}
// The cached value is shared: callers copy what they change (loadProject / listProjects spread every object).
// ------------------------------------------------------------ background work (leak guards)
// A hot reload builds the script again while globalThis (and, for kept views, their timers) can
// survive, so every background job is claimed by key: starting it again supersedes the old one,
// whose timers cancel themselves on their next tick and whose loops exit. Module-level "started"
// flags are not enough (they reset with each build while the old build's timers keep running).
const JOBS = (globalThis.__hvJobs ??= {});
export function claimJob(key) {
  const tok = {};
  JOBS[key] = tok;
  return () => JOBS[key] === tok;
}
// cx.timer.every that cancels itself once alive() turns false (or its owner's cx throws).
export function repeat(cx, ms, fn, alive) {
  let task = null;
  task = cx.timer.every(ms, (cx) => {
    if (alive && !alive()) { try { task?.cancel(); } catch {} return; }
    fn(cx);
  });
  return task;
}
// One folder watch on ~/.herdr shared by every view (instead of one pending watcher per view per build).
// The watch is recursive and ~/.herdr/projects/<slug>/work holds the agents' worktrees (builds,
// node_modules, git objects): only changes to the files the UI reads count, or a busy agent would
// reload every view several times a second.
const WATCH = (globalThis.__hvWatch ??= { p: null });
export function herdrRelevant(paths) {
  const root = herdrHome().toLowerCase();
  for (const raw of paths ?? []) {
    const p = slash(raw).toLowerCase();
    if (p === root || !p.startsWith(`${root}/`)) return true; // root = "refresh everything"
    const parts = p.slice(root.length + 1).split("/");
    const data = (n) => /\.(json|jsonl|md)$/.test(n) && !/^activity-cache|\.tmp$/.test(n);
    if (parts.length === 1) { if (data(parts[0])) return true; continue; } // machines.json, mailbox.json, locks.json…
    if (parts[0] !== "projects") continue; // bin/, editor/, keys/, trash/, herdr.db…
    if (parts.length === 2) return true; // a project folder added or removed
    if (parts.length === 3 && data(parts[2])) return true; // project.json, tasks.json, events.jsonl…
    if (parts[2] === "handoff" && parts.length <= 4) return true;
  }
  return false;
}
function herdrChanged() {
  if (!WATCH.p) {
    WATCH.p = (async () => { for (;;) { const paths = await watchFolder(herdrHome()); if (herdrRelevant(paths)) return paths; } })()
      .finally(() => { WATCH.p = null; });
  }
  return WATCH.p;
}
// Reload now, every `every` ms and after changes under ~/.herdr (a burst of writes = one reload).
// `key` names the view (one per window): a newer build's view supersedes the old one's loops.
// A reload that returns a Task (cx.spawn) is not started again while the previous one still runs.
// Is the Herdr window in front? In the background the views refresh rarely (agents' work is still watched by
// the supervisor; the screen nobody looks at does not need to follow every write).
// keys() copies every key binding from the host (hundreds): the activity bar asked it 14 times per render, which
// was most of the sidebar's frame. One lookup table per 5 s: "hyper-view.<cmd>" → keys.
let KB = { at: 0, map: new Map() };
export function keyForAction(action) {
  if (Date.now() - KB.at > 5000) {
    const map = new Map();
    try {
      for (const b of keys() ?? []) if ((b.section === "layout:hyper-view" || b.section === "global") && !map.has(b.action)) map.set(b.action, b.keys);
    } catch {}
    KB = { at: Date.now(), map };
  }
  return KB.map.get(action) ?? null;
}
export function appActive() { try { return hwin().active !== false; } catch { return true; } }
export const reloadAll = () => setShared("mp.reloadAt", Date.now());
// Types a line into an agent's terminal and presses Enter as a separate key: sent together, a TUI like Codex
// takes the text as a paste and the Enter as a new line in its input box, so the nudge was never submitted.
export function sendToAgent(address, text) {
  return hc(["send", address, String(text).replace(/[\r\n]+$/, "")]).then(() => hc(["send", address, "\r"])).catch(() => {});
}
// Writes a file outside ~/.config/herdr-app (fs/promises may only write there; the host's writeTextFile may
// write anywhere). Parent folders are created with PowerShell once per folder.
const MADE = (globalThis.__hvMadeDirs ??= new Set());
export async function writeOutside(path, text) {
  const p = String(path).replace(/\\/g, "/"), dir = p.slice(0, p.lastIndexOf("/"));
  if (dir && !MADE.has(dir)) {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`], { timeout: 15000 }).catch(() => null);
    MADE.add(dir);
  }
  for (let i = 0; i < 3; i++) {
    const cur = await readTextFile(p).catch(() => null);
    if (cur === text) return true;
    try { await writeTextFile(p, text, cur ?? null); return true; } catch {}
  }
  return false;
}
export function watchData(cx, reload, every = 4000, key = null) {
  const alive = key ? claimJob(`watch:${key}`) : () => true;
  let last = null, lastAt = 0;
  const go = (cx) => {
    if (last && typeof last.is_done === "function" && !last.is_done() && Date.now() - lastAt < 60000) return;
    lastAt = Date.now();
    last = reload(cx);
  };
  go(cx);
  repeat(cx, every, go, alive);
  // Reload now (reloadAll(): the header's Reload button, and after every saved dialog): checked every
  // 0.7 s in memory, so a new agent / task / project shows up at once instead of at the next poll.
  let seenReload = shared("mp.reloadAt") ?? 0;
  repeat(cx, 700, (cx) => {
    const r = shared("mp.reloadAt") ?? 0;
    if (r === seenReload) return;
    if (last && typeof last.is_done === "function" && !last.is_done() && Date.now() - lastAt < 60000) return; // after the running one
    seenReload = r; lastAt = Date.now(); last = reload(cx);
  }, alive);
  cx.spawn(async (cx) => {
    let at = 0;
    for (;;) {
      try { await herdrChanged(); } catch { return; }
      if (!alive()) return;
      // A burst of writes = one reload, and at most one watch reload per 4 s per view (busy agents write
      // events.jsonl many times a second; faster reloads only fought the renders for the UI thread).
      await cx.sleep(Math.max(500, 4000 - (Date.now() - at)));
      // In the background: at most one reload per 30 s (the first look after coming back reloads at once).
      while (alive() && !appActive() && Date.now() - at < 30000) await cx.sleep(1000);
      if (!alive()) return;
      at = Date.now();
      go(cx);
    }
  });
}

// ------------------------------------------------------------ agents in Herdr
export function liveAgent(project, name) {
  if (!project) return null;
  if (demo()) return DEMO_LIVE[name] && project.slug === DEMO_PROJECT.slug ? { address: `demo-${name}`, status: DEMO_LIVE[name] } : null;
  return agentsNow().find((a) => a.space_name === project.name && a.tab_name === name) ?? null;
}
// agents() asks the host each time; a dashboard render calls liveAgent a few hundred times (every card,
// row and avatar), which ran the render out of time. One snapshot per 250 ms is plenty for a status dot.
let AGS = { at: 0, list: [] };
// Is an agent with this name working right now (its terminal says so)? An unfinished command in the log
// alone is not enough: Codex often logs no end for a command (the agent then looked "running" while asleep).
export function agentWorking(name) { return agentsNow().some((a) => a.tab_name === name && a.status === "working"); }
function agentsNow() {
  const n = Date.now();
  if (n - AGS.at > 250) AGS = { at: n, list: agents() ?? [] };
  return AGS.list;
}
// Team lead (answers team messages; same rule as hp's Lead-Of): flagged lead, else name/role says
// lead/architect/coordinator, else the first agent.
export function leadOf(project) {
  const list = project?.agents ?? [];
  return (list.find((a) => a.lead === true) ?? list.find((a) => /lead|architect|coordinator/i.test(`${a.name} ${a.role ?? ""}`)) ?? list[0])?.name ?? null;
}
// Agent names @mentioned in a text.
export function mentionsOf(project, text) {
  const names = (project?.agents ?? []).map((a) => a.name);
  const out = [];
  for (const m of String(text ?? "").matchAll(/(?<![\w@])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const n = names.find((x) => x.toLowerCase() === m[1].toLowerCase());
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
export const projectSpace = (project) => spaces().find((s) => s.named && s.name === project?.name) ?? null;
export function openProjectSpace(project) {
  const sp = projectSpace(project);
  if (sp) run("space.select", { id: sp.id });
}
export function currentTask(project, name) {
  const mine = project.tasks.filter((x) => x.agent === name);
  return mine.find((x) => x.status === "doing") ?? mine.find((x) => x.status === "blocked") ?? null;
}
export function nextTask(project, name) {
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  return project.tasks.filter((x) => x.agent === name && x.status === "todo").sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2))[0] ?? null;
}
// Text that survives being passed as one shell argument: " → ', ` → ', $ → ＄, no control characters.
export const shellSafe = (text) => String(text ?? "").replace(/["“”„]/g, "'").replace(/`/g, "'").replace(/\$/g, "＄").replace(/[\r\n\t]+/g, " ");
export function startAgent(project, agent, goal, { show = false, quiet = false } = {}) {
  // Codex agents run without Codex's OS sandbox (the human's choice, 2026-11-17): on Windows that sandbox could
  // not open hp's database (~/.herdr/herdr.db) even with write access, so hp (memory, inbox, tasks, approvals)
  // did not work. They now run like Claude Code agents: hp's own checks apply (risk level approvals in the
  // Mailbox, secret masking, production machines), and Codex never asks in its terminal.
  const argv = agent.app === "codex" ? ["codex", "--no-daemon", "--dangerously-bypass-approvals-and-sandbox"] : ["claude"];
  const task = [
    `You are agent "${agent.name}" in project "${project.name}".`,
    agent.role ? `Your role: ${agent.role}.` : "",
    `Read AGENTS.md in the current folder: it is your contract (sacred boundaries, principles, working loop). Your risk level: ${agent.risk ?? project.agents?.find((x) => x.name === agent.name)?.risk ?? "balanced"}. Pass --as ${agent.name} to every hp command.`,
    `First run: hp recall "${String((project.tasks ? currentTask(project, agent.name)?.title ?? nextTask(project, agent.name)?.title : null) ?? (goal && String(goal).length <= 160 ? goal : "my next task")).replace(/["\r\n`$]+/g, " ").trim().slice(0, 80)}" --as ${agent.name} (your tasks, team decisions, gotchas, your last session note).`,
    `Decide technical questions yourself; ask the human only about business decisions and risky steps (AGENTS.md section 'Working with ty'), through the lead, in plain simple Polish with numbered choices; keep working on what does not depend on the answer. Never wait for an answer in this terminal: questions go to the Mailbox (hp say --to ty), permissions via hp ask then hp wait-approval.`,
    goal ? `Task from the human: ${goal}` : `Then: hp agent list, hp task list, hp inbox --as ${agent.name}.`,
  ].filter(Boolean).join(" ");
  const folder = winPath(projectDir(project.slug));
  // Skills and MCP servers attached to this agent (kit.js) are written first, then added to its start.
  const launch = (extra, note) => {
    const av = [...argv, ...(extra ?? [])];
    // Herdr hands the first message to the agent through the shell (PowerShell) inside double quotes:
    // a " inside ends the argument early (codex: "unexpected argument 'VDS'"), $ and ` would be expanded.
    const tk = shellSafe(note ? `${task} ${note}` : task);
    const sp = projectSpace(project);
    if (sp) run("tab.new", { space: sp.id, name: agent.name, folder, argv: av, task: tk });
    else run("space.new", { name: project.name, folder, tab: agent.name, argv: av, task: tk });
  };
  if (!quiet) toast(`Starting ${agent.name}…`, "Its terminal opens in Terminals (Ctrl+`).", "info");
  // Writing the kit must never block the start: after 8 s the agent starts without it.
  let done = false;
  const go = (extra, note, err) => {
    if (done) return; done = true;
    if (err) toast("Skills / MCP not applied", err, "error");
    try { launch(extra, note); if (show) showCenter("mp-terms"); } catch (e) { toast(`Could not start ${agent.name}`, String(e?.message ?? e), "error"); }
    setShared("mp.lastStart", { agent: agent.name, project: project.slug, argv: [...argv, ...(extra ?? [])], err: err ?? null, at: Date.now() });
    setShared("mp.reloadAt", Date.now());
  };
  // Lazy import: kit.js → form.js → lib.js at load time would be a cycle (form.js uses lib's constants).
  import("./kit.js").then((m) => m.prepareKit(project, agent)).then((k) => go(k.argv, k.note), (e) => go([], "", String(e?.message ?? e)));
  sleepMs(8000).then(() => go([], "", "Preparing skills / MCP servers took too long."));
}
// Opening a machine = its view, Editor tab (nvim + optional terminal underneath).
export function openSsh(vm, _project) {
  setShared("mp.view", { kind: "vm", name: vm, tab: "editor" });
  import("./editor.js").then((m) => m.openEditor(vm));
}
export const vmStats = () => (demo() ? demoStats() : sharedFast("mp.vmstats") ?? {});

// ------------------------------------------------------------ design tokens
export const OK = "#7fb08a", WARN = "#d4a35a", BAD = "#d57c74", INFO = "#6f9fd0";
export const clear = "#00000000";
export const PALETTE = ["#8aa4c8", "#7c8fb5", "#6f9fd0", "#5fa89a", "#7fb08a", "#d4a35a", "#c98a62", "#c97a7a", "#c48aa3", "#a593c2", "#6fb0bb", "#9bb373"];
const PROJECT_GLYPHS = ["box", "rocket", "brain", "database", "globe", "cloud", "zap", "flame", "leaf", "gamepad", "wallet", "layers", "shopping", "compass", "shield", "git"];
const VM_GLYPHS = ["server", "cpu", "database", "hard-drive", "monitor", "cloud", "network", "terminal"];
function hashOf(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
export const colorFor = (name) => PALETTE[hashOf(name) % PALETTE.length];
export const glyphFor = (name, kind = "project") => {
  const set = kind === "vm" ? VM_GLYPHS : PROJECT_GLYPHS;
  return set[hashOf(`${kind}:${name}`) % set.length];
};
// A colored rounded tile with a white glyph: the "app icon" of a project, VM or agent.
export function tile(name, { kind = "project", size = 24, color, glyph, radius } = {}) {
  const c = color ?? colorFor(`${kind}:${name}`);
  return h_flex().flex_none().size(size).rounded(radius ?? Math.round(size * 0.28)).bg(c).items_center().justify_center()
    .border_1().border_color("#ffffff22")
    .child(svg(icon(glyph ?? glyphFor(name, kind))).size(Math.round(size * 0.56)).text_color("#ffffff"));
}
export const initials = (name) => String(name ?? "?").split(/[\s\-_]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
export const STATUS_EN = { working: "Working", blocked: "Waiting for you", done: "Finished", idle: "Idle" };
export const TASK_EN = { backlog: "Backlog", todo: "To Do", doing: "In Progress", review: "Review", blocked: "Blocked", done: "Done" };
export const TASK_COLOR = { backlog: "#6b6b80", todo: "#9aa3ad", doing: "#8aa4c8", review: "#6f9fd0", blocked: BAD, done: OK };
export const PRIO = { urgent: ["Urgent", "#d57c74"], high: ["High", "#d4a35a"], normal: ["Normal", "#9aa3ad"], low: ["Low", "#6b6b80"] };
export const statusColor = (t, s) => (s === "working" ? OK : s === "blocked" ? WARN : s === "done" ? INFO : s === "idle" ? "#9aa3ad" : t.dim);

// Waiting for you: a thin amber ring 2 px outside the avatar (offset, so it reads on any avatar color;
// absolute, so nothing shifts). Static: no pulsing.
export const waitRing = (size, on = true) => (el) => on ? el.child(div().absolute().top(-3).left(-3).size(size + 6).rounded_full().border_color(WARN).when(size >= 24, (d) => d.border_2()).when(size < 24, (d) => d.border_1())) : el;
export function agentAvatar(t, name, live, size = 28) {
  return div().relative().flex_none()
    .map(waitRing(size, isWaiting(name, live)))
    .child(h_flex().size(size).rounded_full().items_center().justify_center().bg(colorFor(`agent:${name}`))
      .border_1().border_color("#ffffff1f")
      .child(svg(icon("bot")).size(Math.round(size * 0.55)).text_color("#ffffff")))
    .child(div().absolute().right(-1).bottom(-1).size(Math.max(8, Math.round(size * 0.3))).rounded_full().border_2().border_color(t.surface)
      .bg(live ? statusColor(t, live.status) : "#55556a"));
}
export function iconEl(name, color, size = 14) {
  let el = svg(icon(name)).flex_none().size(size);
  if (color) el = el.text_color(color);
  return el;
}
export function meter(t, pct, color, height = 4) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const c = color ?? (v > 90 ? BAD : v > 75 ? WARN : t.accent);
  return div().h(height).w_full().rounded_full().bg(t.hover).overflow_hidden()
    .child(div().h_full().w(`${v}%`).rounded_full().bg(c));
}
// Status label: a small dot + colored text, no filled background (quiet, scannable).
export function pill(t, text, color, { dot = true } = {}) {
  return h_flex().flex_none().h(T.h.chip).gap(T.sp.sm).items_center()
    .text_color(color).text_size(T.text.xs).font_medium()
    .when(dot, (el) => el.child(div().size(T.dot).rounded_full().bg(color))).child(text);
}
const stop = (_e, cx) => cx.stop_propagation();
export function button(t, id, label, onClick, { primary = false, danger = false, small = false, iconName = null, ghost = false } = {}) {
  const bg = primary ? t.accent : danger ? `${BAD}22` : ghost ? clear : t.raised;
  const fg = primary ? t.accent_foreground : danger ? BAD : t.foreground;
  return h_flex().id(id).flex_none().gap(6).items_center().h(small ? T.h.btnSm : T.h.btn).px(small ? T.sp.md : T.sp.lg).rounded(T.r.ctrl)
    .border_1().border_color(primary ? `${t.accent.slice(0, 7)}` : ghost ? clear : t.border).bg(bg)
    .text_color(fg).text_size(T.text.sm).font_medium().cursor_pointer()
    .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover)))
    .on_mouse_down("left", stop)
    .on_click((e, cx) => onClick(e, cx))
    .when(Boolean(iconName), (el) => el.child(iconEl(iconName, fg, small ? T.icon.sm : T.icon.row)))
    .when(Boolean(label), (el) => el.child(label));
}
export function iconButton(t, id, iconName, onClick, tip, { size = T.h.icon, color, filled = false } = {}) {
  let el = h_flex().id(id).flex_none().size(size).rounded(T.r.ctrl).items_center().justify_center().cursor_pointer()
    .bg(filled ? t.raised : clear).when(filled, (e) => e.border_1().border_color(t.border))
    .text_color(color ?? t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((e, cx) => onClick(e, cx))
    .child(svg(icon(iconName)).size(size <= T.h.icon ? T.icon.row : T.icon.toolbar));
  if (tip) el = el.tooltip(tip);
  return el;
}
export function tabsBar(t, idPrefix, items, active, onPick) {
  return h_flex().id(`${idPrefix}-tabs`).gap(4).items_end().children(items.map(([key, label, count]) =>
    v_flex().id(`${idPrefix}-${key}`).flex_none().cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => onPick(key, cx))
      .child(h_flex().h(T.h.tab).px(T.sp.sm).gap(6).items_center().text_size(T.text.base).font_medium()
        .text_color(active === key ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .child(label)
        .when(count != null && count !== "" && count !== 0, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(String(count)))))
      .child(div().h(2).mx(T.sp.sm).rounded_full().bg(active === key ? t.accent : clear))));
}
export function card(t, id) {
  return v_flex().id(id).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border);
}
export function cardHeader(t, title, right, sub) {
  return h_flex().px(T.pad.card).pt(T.pad.card).pb(T.sp.md).gap(T.sp.md).items_center()
    .child(v_flex().flex_1().min_w(0)
      .child(div().text_size(T.text.base).font_semibold().child(title))
      .when(Boolean(sub), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(sub))))
    .when(Boolean(right), (el) => el.child(right));
}
// A vertical scroll area with a slim, always-grabbable scrollbar on its right edge.
// `el` is the content column (it gets the id + overflow_y_scroll). grow: the area fills the
// remaining height of its flex column; otherwise it keeps its own height (h / max_h / content).
// Scroll areas: the bar is invisible (it only flashes thinly while you scroll); move the pointer to
// the right edge and a slim, grabbable bar appears. Hover state per area id.
const SB_HOVER = (globalThis.__hvSbHover ??= {});
export function scrollY(id, el, { grow = true } = {}) {
  const area = el.id(id).overflow_y_scroll();
  const hot = Boolean(SB_HOVER[id]);
  return v_flex().relative().w_full().when(grow, (w) => w.flex_1().min_h(0))
    // A fixed-height list inside a scrolling page/dialog (grow: false): the wheel over it scrolls only
    // the list, not the page around it.
    .when(!grow, (w) => w.on_scroll_wheel((_e, cx) => cx.stop_propagation()))
    .child(grow ? area.flex_1().min_h(0) : area)
    .child(div().id(`${id}-sbzone`).absolute().top(2).bottom(2).right(0).w(10)
      .on_hover((h, cx) => { SB_HOVER[id] = h; cx.notify(); })
      .child(div().absolute().top(0).bottom(0).right(1).w(hot ? 6 : 3)
        .child(Scrollbar.vertical(id).mode(hot ? "always" : "scrolling").size_full())));
}
export function empty(t, text) {
  return div().px(T.pad.card).py(T.pad.card).text_size(T.text.sm).text_color(t.dim).whitespace_normal().child(text);
}
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
export const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "–");
const pad = (n) => String(n).padStart(2, "0");
export function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  return `${months[d.getMonth()]} ${d.getDate()}, ${time}`;
}
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function toast(title, body, level = "info") { notify({ title, body, level, timeout: 5000 }); }
export function vmHealth(st) {
  if (!st) return ["Checking", "#9aa3ad"];
  if (!st.ok) return ["Offline", BAD];
  if (st.cpu > 90 || st.ram > 92 || st.disk > 92) return ["Degraded", WARN];
  return ["Online", OK];
}

// Balanced responsive grid: as many columns as fit (each at least `min` px), then rows are
// evened out (6 items that fit 5 per row become 3 + 3, never 5 + 1). Every cell gets the
// same width, so tiles line up and wrap cleanly as the window narrows.
export function gridCols(n, width, { min = 220, gap = 12, max = Infinity } = {}) {
  const fit = Math.max(1, Math.min(n, max, Math.floor((width + gap) / (min + gap))));
  const rows = Math.ceil(n / fit);
  const cols = Math.ceil(n / rows);
  return { cols, rows, w: Math.floor((width - gap * (cols - 1)) / cols) };
}
export function grid(id, items, width, opts = {}) {
  const n = items.length;
  if (!n) return div();
  const gap = opts.gap ?? 12;
  const { cols, rows, w } = gridCols(n, width, opts);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const slice = items.slice(r * cols, r * cols + cols);
    // Cells share the row exactly (flex 1 each); a short last row is padded with empty
    // cells so its tiles keep the same width as the rows above.
    const cells = slice.map((el, i) => v_flex().id(`${id}-c${r}-${i}`).flex_1().flex_basis(0).min_w(0).child(el.flex_1()));
    for (let k = slice.length; k < cols; k++) cells.push(div().id(`${id}-pad${r}-${k}`).flex_1().flex_basis(0));
    out.push(h_flex().id(`${id}-r${r}`).w_full().gap(gap).items_stretch().children(cells));
  }
  return v_flex().id(id).w_full().gap(gap).children(out);
}

// Main + side panel: side by side on wide views, stacked when narrow.
export const STACK_BELOW = 920;
// Side by side, both columns stretch to the same height so cards line up.
export const splitRow = (width) => (width < STACK_BELOW ? v_flex().gap(16) : h_flex().gap(16).items_stretch());
export const sideCol = (el, width, w) => (width < STACK_BELOW ? el.w_full() : el.w(w).flex_none());

export function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}
export const usageTotal = (u) => (u ? (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_write || 0) : 0);

// ------------------------------------------------------------ machine terminal (VM view → Terminal tab)
// Each machine gets one background ssh terminal in herdr-core (named vm-<machine>, not in any tab),
// shown full-size in the layout block "mp-vmterm-term" under the machine's header.
const termName = (vm) => `vm-${vm}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
// Herdr drops a layout block whose terminal has ended, so the blocks are rebuilt every time.
// bindBlocks(children) replaces everything in the "mp-vmterm" column (editor: path bar, nvim, terminal).
export function bindBlocks(children, { gap = 0 } = {}) {
  const tree = JSON.parse(JSON.stringify(layout()));
  const walk = (n) => { if (!n || typeof n !== "object") return null; if (n.id === "mp-vmterm") return n; for (const c of n.children ?? []) { const f = walk(c); if (f) return f; } return null; };
  const col = walk(tree);
  if (!col) return false;
  const key = (list) => JSON.stringify((list ?? []).map((c) => [c.id, c.content, c.size ?? null]));
  if (key(col.children) === key(children) && (col.gap ?? 0) === gap) return true;
  col.children = children;
  col.gap = gap;
  // run("layout.set") from a mod did not apply the change; the CLI does.
  return exec("herdr-app", ["do", "layout.set", "--layout", JSON.stringify(tree)], { timeout: 20000 }).then(() => true).catch(() => { run("layout.set", { layout: tree }); return true; });
}
export const termBlock = (id, content, size) => ({ id, type: "block", radius: 10, border: { width: 1, color: "border" }, background: "background", content, ...(size ? { size: { px: size } } : {}) });
function bindTerminalBlock(content) { return bindBlocks([termBlock("mp-vmterm-term", content)]); }
export { parseJson, sleepMs, termName };
export async function connectVm(vm) {
  setShared("mp.vmterm", { vm, state: "connecting", at: Date.now() });
  await bindTerminalBlock({ mod: MOD, props: { role: "vmterm-empty" } });
  showCenter("mp-vmterm");
  const name = termName(vm);
  let t = parseJson((await hc(["get", name, "--json"]).catch(() => ({ stdout: "" }))).stdout);
  if (!t || t.state !== "live") {
    if (t) await hc(["rm", name]).catch(() => {});
    const r = await hc(["run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent", "--", "ssh", sshAlias(vm)]).catch((e) => ({ stdout: "", stderr: String(e) }));
    t = parseJson(r.stdout);
    if (!t?.address) { setShared("mp.vmterm", { vm, state: "error", err: (r.stderr || "Could not start ssh").trim(), at: Date.now() }); return; }
  }
  // ssh that fails (unknown host, no key) exits within a second or two: show why instead of a dead terminal.
  for (let i = 0; i < 6; i++) {
    const g = parseJson((await hc(["get", name, "--json"]).catch(() => ({ stdout: "" }))).stdout);
    if (g && g.state !== "live") {
      const out = (await hc(["read", t.address, "--lines", "6"]).catch(() => ({ stdout: "" }))).stdout.trim().split("\n").filter(Boolean).slice(-3).join(" ");
      setShared("mp.vmterm", { vm, state: "error", err: out || `ssh exited (${g.exit_code ?? "?"})`, at: Date.now() });
      await bindTerminalBlock({ mod: MOD, props: { role: "vmterm-empty" } });
      return;
    }
    if (i >= 2) break;
    await sleepMs(500);
  }
  setShared("mp.vmterm", { vm, state: "live", address: t.address, at: Date.now() });
  await bindTerminalBlock({ terminal: t.address });
  run("pane.focus", { terminal: t.address });
}
function sleepMs(ms) { return exec("powershell.exe", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`], { timeout: ms + 5000 }).catch(() => null); }

// Installs the SSH key on a machine in the same full-size block as its terminal: you type the
// password once, and when it succeeds the machine's terminal opens. No Herdr space needed.
export async function installKey(vm) {
  setShared("mp.view", { kind: "vm", name: vm, tab: "editor" });
  setShared("mp.vmterm", { vm, state: "connecting", label: `Installing SSH key on ${vm}…`, at: Date.now() });
  await bindTerminalBlock({ mod: MOD, props: { role: "vmterm-empty" } });
  showCenter("mp-vmterm");
  const name = `vmkey-${vm}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  await hc(["rm", name]).catch(() => {});
  const r = await hc(["run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent", "--",
    "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", winPath(hpScript()), "vm", "trust", vm]).catch((e) => ({ stdout: "", stderr: String(e) }));
  const t = parseJson(r.stdout);
  if (!t?.address) { setShared("mp.vmterm", { vm, state: "error", err: (r.stderr || "Could not start").trim(), retry: "key", at: Date.now() }); return; }
  await bindTerminalBlock({ terminal: t.address });
  run("pane.focus", { terminal: t.address });
  // Wait for it to finish (password prompt included), up to 10 minutes.
  for (let i = 0; i < 300; i++) {
    await sleepMs(2000);
    const g = parseJson((await hc(["get", name, "--json"]).catch(() => ({ stdout: "" }))).stdout);
    if (!g || g.state === "live") continue;
    const out = (await hc(["read", t.address, "--lines", "8"]).catch(() => ({ stdout: "" }))).stdout.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    if (g.exit_code === 0) {
      setShared("mp.vmProbeAsk", { vm, at: Date.now() }); // refresh its status now, not at the next 5-min round
      setShared("mp.vmterm", { vm, state: "connecting", label: "SSH key installed. Opening the editor…", at: Date.now() });
      await (await import("./editor.js")).openEditor(vm);
    } else {
      setShared("mp.vmterm", { vm, state: "error", err: out || `exit code ${g.exit_code}`, retry: "key", at: Date.now() });
      await bindTerminalBlock({ mod: MOD, props: { role: "vmterm-empty" } });
    }
    return;
  }
}

// ------------------------------------------------------------ loose agents and logins
export const looseSlug = (name) => `agent-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// Runs a program in the full-size terminal block (same block the machine terminal uses).
export async function runInBlock(view, name, argv, afterStart) {
  setShared("mp.view", view);
  setShared("mp.vmterm", { vm: view.title ?? name, state: "connecting", label: view.label ?? "Starting…", at: Date.now() });
  await bindTerminalBlock({ mod: MOD, props: { role: "vmterm-empty" } });
  showCenter("mp-vmterm");
  await hc(["kill", name]).catch(() => {});
  await hc(["rm", name]).catch(() => {});
  const r = await hc(["run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent", "--", ...argv]).catch((e) => ({ stdout: "", stderr: String(e) }));
  const t = parseJson(r.stdout);
  if (!t?.address) { setShared("mp.vmterm", { vm: view.title ?? name, state: "error", err: (r.stderr || "Could not start").trim(), at: Date.now() }); return null; }
  await bindTerminalBlock({ terminal: t.address });
  run("pane.focus", { terminal: t.address });
  if (afterStart) await afterStart(t.address);
  return t.address;
}

// Log in to Claude Code or Codex: their own login flow opens the provider's page in the browser.
export async function loginProvider(provider) {
  const claude = provider === "claude";
  await runInBlock({ kind: "login", provider, title: claude ? "Claude Code" : "Codex", label: `Starting ${claude ? "Claude Code" : "Codex"} login…` },
    `login-${provider}`, claude ? ["claude"] : ["codex", "login"],
    claude ? async (addr) => { await sleepMs(2500); await hc(["send", addr, "/login"]).catch(() => {}); } : null);
}
