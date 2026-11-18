// VM "Editor" tab: an IDE-style Neovim running on this PC (nvim/init.lua: file tree, fuzzy finder,
// git signs, start screen) that edits the machine's files over SSH (nothing is installed on the machine).
// Above it a slim IDE header shows breadcrumbs of where the editor is, the git branch, and
// Files · Search · Commands · Terminal buttons. The Terminal toggle opens the machine's SSH shell under it.
// Demo mode (shared "mp.demo"): machines are fake, so the editor opens a local sample repo in
// ~/.herdr/demo-workspace/<vm>/ (from nvim/demo-repo.json, created once, git-initialized when git exists) and the terminal
// under it is a local PowerShell in that folder.
// Layout: the "mp-vmterm" column gets [header bar, nvim terminal, (shell terminal)].
import { T } from "./tokens.js";
import { div, svg } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { theme, shared, setShared, props, exec, hc, run, readTextFile, appHome, home } from "herdr";
import * as fs from "fs/promises";
import {
  MOD, claimJob, repeat, icon, herdrHome, sshAlias, showCenter, bindBlocks, termBlock, parseJson, sleepMs, tile, toast, demo,
} from "./lib.js";

const winPath = (p) => String(p).replace(/\//g, "\\");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "-");
const vimStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const initPath = () => `${String(appHome()).replace(/\\/g, "/")}/mods/${MOD}/nvim/init.lua`;
const termOpen = (vm) => Boolean((shared("mp.edTerm") ?? {})[vm]);
const isLight = (t) => { const h = String(t.background ?? "#000").replace("#", ""); const n = parseInt(h.slice(0, 6), 16); return ((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11 > 140; };
const pluginsDir = () => `${herdrHome()}/nvim/lazy`;

// Everything that differs between a real machine (ssh) and demo mode (local sample repo).
function ctxFor(vm) {
  const d = demo();
  return {
    vm, demo: d,
    name: `${d ? "edd" : "ed"}-${slug(vm)}`.slice(0, 32),
    pipe: `\\\\.\\pipe\\hv-nvim-${d ? "demo-" : ""}${slug(vm)}`,
    state: `${herdrHome()}/editor/${safe(vm)}${d ? ".demo" : ""}.json`,
    shell: d ? `edsh-${slug(vm)}`.slice(0, 32) : `vm-${slug(vm)}`.slice(0, 32),
    root: d ? `${herdrHome()}/demo-workspace/${safe(vm)}` : null,
  };
}

// ------------------------------------------------------------ tools on this PC
// nvim (required), git (plugins, git signs), rg/fd (fast file + text search), lazygit (optional).
let toolsCache = null;
export async function findTools(force) {
  if (toolsCache && !force) return toolsCache;
  const names = ["nvim", "git", "rg", "fd", "lazygit"];
  const w = await exec("where.exe", names, { timeout: 10000 }).catch(() => null);
  const lines = String(w?.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const found = {};
  for (const n of names) found[n] = lines.find((l) => new RegExp(`[\\\\/]${n}\\.(exe|cmd|bat)$`, "i").test(l)) ?? null;
  const links = `${String(home()).replace(/\\/g, "/")}/AppData/Local/Microsoft/WinGet/Links`;
  const missing = ["rg", "fd", "lazygit"].filter((n) => !found[n]);
  if (missing.length) {
    const r = await exec("cmd.exe", ["/d", "/c", missing.map((n) => `if exist "${winPath(`${links}/${n}.exe`)}" echo ${n}`).join(" & ")], { timeout: 8000 }).catch(() => null);
    for (const n of String(r?.stdout ?? "").split(/\s+/).filter((x) => missing.includes(x))) found[n] = winPath(`${links}/${n}.exe`);
  }
  let nvim = null;
  for (const cand of [found.nvim, "C:\\Program Files\\Neovim\\bin\\nvim.exe"].filter(Boolean)) {
    const r = await exec(cand, ["--version"], { timeout: 8000 }).catch(() => null);
    if (r?.code === 0) { nvim = cand; found.nvimVersion = (r.stdout.match(/NVIM v([\d.]+)/) ?? [])[1] ?? null; break; }
  }
  toolsCache = { ...found, nvim };
  setShared("mp.edTools", { git: Boolean(found.git), rg: Boolean(found.rg), lazygit: Boolean(found.lazygit), at: Date.now() });
  // Dev bridge aid: what this PC has (only when the designer bridge folder is in use).
  const dev = `${String(appHome()).replace(/\\/g, "/")}/.hv-dev`;
  if (await fs.exists(`${dev}/cmd.json`).catch(() => false)) {
    const plugins = await pluginsReady();
    fs.writeFile(`${dev}/editor-tools.json`, JSON.stringify({ ...toolsCache, plugins, at: new Date().toISOString() }, null, 2)).catch(() => {});
  }
  return toolsCache;
}
export const pluginsReady = async () => Boolean(await readTextFile(`${pluginsDir()}/snacks.nvim/README.md`).catch(() => null));

// ------------------------------------------------------------ demo workspace
// Mods may only write inside their own folder, so the files go to .gen/ as JSON and PowerShell
// writes them out (UTF-8, no BOM); git runs in the new folder.
const genDir = () => `${String(appHome()).replace(/\\/g, "/")}/mods/${MOD}/.gen`;
async function writeTree(root, files, tag) {
  const bundle = `${genDir()}/demo-ws-${tag}.json`;
  await fs.mkdir(genDir(), { recursive: true }).catch(() => {});
  await fs.writeFile(bundle, JSON.stringify(files));
  const ps = `$ErrorActionPreference='Stop'; $root=${psStr(winPath(root))}; $enc=New-Object System.Text.UTF8Encoding $false; `
    + `$b=[System.IO.File]::ReadAllText(${psStr(winPath(bundle))}, $enc) | ConvertFrom-Json; `
    + `foreach ($p in $b.PSObject.Properties) { $f=Join-Path $root ($p.Name -replace '/', '\\'); `
    + `[void](New-Item -ItemType Directory -Force -Path (Split-Path $f)); [System.IO.File]::WriteAllText($f, $p.Value, $enc) }`;
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  fs.unlink(bundle).catch(() => {});
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "PowerShell failed").trim().split(/\r?\n/)[0]);
}
const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
async function ensureDemoWorkspace(c, tools) {
  const root = c.root;
  if (await readTextFile(`${root}/.hv-demo`).catch(() => null)) return;
  const tpl = await readTextFile(`${String(appHome()).replace(/\\/g, "/")}/mods/${MOD}/nvim/demo-repo.json`);
  if (!tpl) throw new Error("nvim/demo-repo.json is missing");
  const name = String(c.vm).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const files = JSON.parse(tpl.replace(/@@NAME@@/g, name).replace(/@@VM@@/g, String(c.vm).replace(/["\\]/g, "")));
  await writeTree(root, files.initial, safe(c.vm));
  if (tools.git) {
    const git = (args) => exec(tools.git, ["-c", "user.name=Demo Dev", "-c", "user.email=dev@example.com", "-c", "core.autocrlf=false", ...args], { cwd: winPath(root), timeout: 20000 }).catch(() => null);
    await git(["init", "-q", "-b", "main"]);
    for (const [msg, paths] of files.commits) { await git(["add", "--", ...paths]); await git(["commit", "-q", "-m", msg]); }
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "Status cards and API client"]);
    await git(["checkout", "-q", "-b", "feature/health-retry"]);
  }
  // Work in progress (shows git signs, a modified file and an untracked file), then the marker.
  const marker = { ".hv-demo": "hyper-view demo workspace (delete this folder to recreate it)\n" };
  if (tools.git) marker[".git/info/exclude"] = ".hv-demo\n";
  await writeTree(root, { ...files.changes, ...marker }, `${safe(c.vm)}-wip`);
}

// ------------------------------------------------------------ layout
const barBlock = (vm) => ({ id: "mp-ed-bar", type: "block", size: { px: T.h.header }, resizable: false, content: { mod: MOD, props: { role: "editor-bar", vm } } });
const emptyBlock = () => termBlock("mp-vmterm-term", { mod: MOD, props: { role: "vmterm-empty" } });
function blocks(vm, editorContent, shellAddress) {
  const list = [barBlock(vm), termBlock("mp-vmterm-term", editorContent)];
  if (shellAddress) list.push(termBlock("mp-ed-term", { terminal: shellAddress }, 240));
  return bindBlocks(list, { gap: 8 });
}

async function liveTerm(name) {
  const g = parseJson((await hc(["get", name, "--json"]).catch(() => ({ stdout: "" }))).stdout);
  return g && g.state === "live" ? g : null;
}

// The shell under the editor: the machine's SSH shell, or (demo) a local PowerShell in the workspace.
async function ensureShell(c) {
  let t = await liveTerm(c.shell);
  if (t) return t.address;
  await hc(["rm", c.shell]).catch(() => {});
  const argv = c.demo ? ["--cwd", winPath(c.root), "--", "powershell.exe", "-NoLogo"] : ["--", "ssh", sshAlias(c.vm)];
  const r = await hc(["run", "--bg", "--json", "--name", c.shell, "--no-parent", "--outlive-parent", ...argv]).catch(() => ({ stdout: "" }));
  t = parseJson(r.stdout);
  return t?.address ?? null;
}

export async function openEditor(vm) {
  const c = ctxFor(vm);
  setShared("mp.view", { kind: "vm", name: vm, tab: "editor" });
  showCenter("mp-vmterm");
  let t = await liveTerm(c.name);
  if (!t) {
    setShared("mp.vmterm", { vm, state: "connecting", editor: true, at: Date.now(),
      label: c.demo ? `Preparing the demo workspace for ${vm}…` : `Opening the editor on ${vm}…` });
    await bindBlocks([barBlock(vm), emptyBlock()], { gap: 8 });
    const tools = await findTools();
    if (!tools.nvim) {
      setShared("mp.vmterm", { vm, state: "error", editor: true, install: true, at: Date.now(),
        err: c.demo ? "Neovim is not installed on this PC. Install it once (with Git and ripgrep); the demo opens a sample project in it."
          : "Neovim is not installed on this PC. Install it once (with Git and ripgrep); it edits the machine's files over SSH." });
      return;
    }
    if (c.demo) {
      try { await ensureDemoWorkspace(c, tools); } catch (e) {
        setShared("mp.vmterm", { vm, state: "error", editor: true, err: `Could not create the demo workspace: ${e?.message ?? e}`, at: Date.now() });
        return;
      }
    }
    await hc(["rm", c.name]).catch(() => {});
    const vars = [
      c.demo ? "let g:hv_local=1" : `let g:hv_host=${vimStr(sshAlias(vm))}`,
      `let g:hv_name=${vimStr(vm)}`,
      `let g:hv_state=${vimStr(c.state)}`,
      tools.rg ? `let g:hv_rg=${vimStr(tools.rg)}` : null,
      tools.fd ? `let g:hv_fd=${vimStr(tools.fd)}` : null,
      `set background=${isLight(theme()) ? "light" : "dark"}`,
    ].filter(Boolean).join(" | ");
    const cwd = c.demo ? ["--cwd", winPath(c.root)] : [];
    const r = await hc(["run", "--bg", "--json", "--name", c.name, "--no-parent", "--outlive-parent", ...cwd, "--",
      tools.nvim, "--listen", c.pipe, "-u", winPath(initPath()), "--cmd", vars]).catch((e) => ({ stdout: "", stderr: String(e) }));
    t = parseJson(r.stdout);
    if (!t?.address) { setShared("mp.vmterm", { vm, state: "error", editor: true, err: (r.stderr || "Could not start Neovim").trim(), at: Date.now() }); return; }
  }
  setShared("mp.vmterm", { vm, state: "live", editor: true, address: t.address, at: Date.now() });
  const sh = termOpen(vm) ? await ensureShell(c) : null;
  await blocks(vm, { terminal: t.address }, sh);
  run("pane.focus", { terminal: t.address });
}

export async function toggleTerminal(vm) {
  const c = ctxFor(vm);
  const next = !termOpen(vm);
  setShared("mp.edTerm", { ...(shared("mp.edTerm") ?? {}), [vm]: next });
  const ed = await liveTerm(c.name);
  const sh = next ? await ensureShell(c) : null;
  if (next && !sh) toast(c.demo ? "Could not open PowerShell" : `Could not open a shell on ${vm}`, c.demo ? "" : "Check the machine's SSH access.", "error");
  await blocks(vm, ed ? { terminal: ed.address } : { mod: MOD, props: { role: "vmterm-empty" } }, sh);
  if (sh) run("pane.focus", { terminal: sh });
  else if (ed) run("pane.focus", { terminal: ed.address });
}

async function sendKeys(vm, keys) {
  const c = ctxFor(vm);
  const tools = await findTools();
  if (!tools.nvim || !(await liveTerm(c.name))) return false;
  await exec(tools.nvim, ["--server", c.pipe, "--remote-send", keys], { timeout: 8000 }).catch(() => null);
  return true;
}
const focusEditor = async (vm) => { const ed = await liveTerm(ctxFor(vm).name); if (ed) run("pane.focus", { terminal: ed.address }); };

// Runs a Lua call in the editor (e.g. "HvAction('files')"), then gives it the keyboard.
// <Cmd> works from typing (Insert/Select) mode too, so the editor never drops to Normal mode.
export async function editorAction(vm, lua) {
  if (!(await sendKeys(vm, `<Cmd>lua ${lua}<CR>`))) { await openEditor(vm); return; }
  await focusEditor(vm);
}

// Tells the running editor to open a path (remote "~/app", "/etc"; local "C:/…" in demo).
export async function gotoPath(vm, path) {
  const safeP = String(path).replace(/[\]\r\n]/g, "");
  await editorAction(vm, `HvOpen([[${safeP}]])`);
}

// Installs Neovim + Git + ripgrep with winget, shown in the editor block.
export async function installNvim(vm) {
  setShared("mp.vmterm", { vm, state: "connecting", editor: true, label: "Installing Neovim…", at: Date.now() });
  const name = "ed-install";
  await hc(["rm", name]).catch(() => {});
  const w = (id, cmd) => `if (-not (Get-Command ${cmd} -ErrorAction SilentlyContinue)) { winget install -e --id ${id} --accept-source-agreements --accept-package-agreements }`;
  const script = ["winget install -e --id Neovim.Neovim --accept-source-agreements --accept-package-agreements", w("Git.Git", "git"), w("BurntSushi.ripgrep.MSVC", "rg")].join("; ");
  const r = await hc(["run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent", "--", "powershell.exe", "-NoProfile", "-Command", script]).catch(() => ({ stdout: "" }));
  const t = parseJson(r.stdout);
  if (!t?.address) { setShared("mp.vmterm", { vm, state: "error", editor: true, install: true, err: "Could not start winget.", at: Date.now() }); return; }
  await bindBlocks([barBlock(vm), termBlock("mp-vmterm-term", { terminal: t.address })], { gap: 8 });
  for (let i = 0; i < 300; i++) {
    await sleepMs(2000);
    if (await liveTerm(name)) continue;
    toolsCache = null;
    await openEditor(vm);
    return;
  }
}

// Installs ripgrep (fast project search) with winget in the terminal slot under the editor.
let rgInstalling = false;
export async function installRipgrep(vm) {
  if (rgInstalling) return;
  rgInstalling = true;
  try {
    const name = "ed-rg-install";
    await hc(["rm", name]).catch(() => {});
    const r = await hc(["run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent", "--", "powershell.exe", "-NoProfile", "-Command",
      "winget install -e --id BurntSushi.ripgrep.MSVC --accept-source-agreements --accept-package-agreements; Start-Sleep -Seconds 2"]).catch(() => ({ stdout: "" }));
    const t = parseJson(r.stdout);
    if (!t?.address) { toast("Could not start winget", "Install ripgrep by hand: winget install BurntSushi.ripgrep.MSVC", "error"); return; }
    const ed = await liveTerm(ctxFor(vm).name);
    await blocks(vm, ed ? { terminal: ed.address } : { mod: MOD, props: { role: "vmterm-empty" } }, t.address);
    for (let i = 0; i < 150 && await liveTerm(name); i++) await sleepMs(2000);
    const tools = await findTools(true);
    if (tools.rg) {
      // Tell the running editor where rg is (its PATH is from before the install).
      await sendKeys(vm, `<Cmd>lua HvSetTool('rg', [[${tools.rg}]])<CR>`);
      toast("ripgrep installed", "Ctrl+P and project search now use it.");
    } else toast("ripgrep is not installed", "winget did not finish; try again or install it by hand.", "error");
    await hc(["rm", name]).catch(() => {});
    const sh = termOpen(vm) ? await ensureShell(ctxFor(vm)) : null;
    await blocks(vm, ed ? { terminal: ed.address } : { mod: MOD, props: { role: "vmterm-empty" } }, sh);
    await focusEditor(vm);
  } finally { rgInstalling = false; }
}

// ------------------------------------------------------------ header bar (role "editor-bar")
// Breadcrumb segments for a path: [{label, path}]. Local paths are shown from the workspace root.
function crumbs(path, root) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = root ? String(root).replace(/\\/g, "/").replace(/\/+$/, "") : null;
  if (r && (p.toLowerCase() === r.toLowerCase() || p.toLowerCase().startsWith(`${r.toLowerCase()}/`))) {
    const rest = p.slice(r.length).split("/").filter(Boolean);
    const out = [{ label: r.slice(r.lastIndexOf("/") + 1), path: r }];
    rest.forEach((s, i) => out.push({ label: s, path: `${r}/${rest.slice(0, i + 1).join("/")}` }));
    return out;
  }
  if (p === "" || p === "~") return [{ label: "~", path: "~" }];
  if (p.startsWith("~/")) {
    const rest = p.slice(2).split("/").filter(Boolean);
    return [{ label: "~", path: "~" }, ...rest.map((s, i) => ({ label: s, path: `~/${rest.slice(0, i + 1).join("/")}` }))];
  }
  const drive = p.match(/^[A-Za-z]:/)?.[0];
  const body = drive ? p.slice(2) : p;
  const rest = body.split("/").filter(Boolean);
  const base = drive ?? "";
  return [{ label: drive ?? "/", path: drive ? `${drive}/` : "/" }, ...rest.map((s, i) => ({ label: s, path: `${base}/${rest.slice(0, i + 1).join("/")}` }))];
}

// Branch of a local folder: the nearest .git/HEAD above it.
async function localBranch(path) {
  let p = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  for (let i = 0; i < 12 && p; i++) {
    const head = await readTextFile(`${p}/.git/HEAD`).catch(() => null);
    if (head) return head.startsWith("ref:") ? head.trim().replace(/^ref:\s*refs\/heads\//, "") : head.trim().slice(0, 7);
    const cut = p.lastIndexOf("/");
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return null;
}

export class EditorBar {
  init(cx) {
    this.vm = (props() ?? {}).vm;
    this.path = null;
    this.editing = false;
    this.sel = -1;
    this.input = InputState.new({ value: "", placeholder: "Go to a folder or file…" });
    this.input.on("blur", (_e, cx) => { this.editing = false; cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      const p = this.input.value().trim();
      this.editing = false;
      if (p) gotoPath(this.vm, p);
      cx.notify();
    });
    const poll = (cx) => cx.spawn(async (cx) => {
      const c = ctxFor(this.vm);
      const s = parseJson(await readTextFile(c.state).catch(() => null));
      let dirty = false;
      if (c.demo !== this.demo) { this.demo = c.demo; this.path = null; this.branch = null; dirty = true; }
      const path = s?.path ?? (c.demo ? c.root : null);
      if (path && path !== this.path) {
        this.path = path;
        const isDir = s ? Boolean(s.dir) : true;
        this.branch = c.demo ? await localBranch(isDir ? path : path.slice(0, path.lastIndexOf("/"))) : s?.branch ?? null;
        dirty = true;
      } else if (!c.demo && (s?.branch ?? null) !== this.branch) { this.branch = s?.branch ?? null; dirty = true; }
      if (Boolean(s?.modified) !== Boolean(this.modified)) { this.modified = Boolean(s?.modified); dirty = true; }
      if (Boolean(s?.ready) !== Boolean(this.ready)) { this.ready = Boolean(s?.ready); dirty = true; }
      // Requests from inside the editor (Ctrl+` → terminal, Commands › Path bar → this bar).
      // The file holds "<kind> <counter>"; act on each new counter (mods cannot delete it).
      const req = (await readTextFile(`${c.state}.req`).catch(() => null))?.trim() ?? "";
      if (this.lastReq === undefined || this.reqFor !== c.state) { this.lastReq = req; this.reqFor = c.state; }
      else if (req && req !== this.lastReq) {
        this.lastReq = req;
        const kind = req.split(/\s+/)[0];
        if (kind === "term") toggleTerminal(this.vm);
        else if (kind === "bar") { this.wantFocus = true; dirty = true; }
      }
      if (this.setup === undefined || (this.setup && !this.ready)) {
        const ready = await pluginsReady();
        if (this.setup !== !ready) { this.setup = !ready; dirty = true; }
      }
      const tools = shared("mp.edTools");
      if (tools && tools.rg !== this.rg) { this.rg = tools.rg; dirty = true; }
      if (dirty) cx.notify();
    });
    poll(cx);
    repeat(cx, 700, (cx) => poll(cx), claimJob(`editor:${this.vm}`));
  }

  // Keyboard: Left/Right (or Tab) move between header items, Enter/Space activates,
  // L or / types a path, Escape goes back to the editor.
  onKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.editing || m.control || m.alt || m.platform || !this.fh?.is_focused()) return;
    const items = this.items ?? [];
    if (!items.length) return;
    if (k === "right" || (k === "tab" && !m.shift)) this.sel = (this.sel + 1) % items.length;
    else if (k === "left" || (k === "tab" && m.shift)) this.sel = (this.sel - 1 + items.length) % items.length;
    else if (k === "home") this.sel = 0;
    else if (k === "end") this.sel = items.length - 1;
    else if ((k === "enter" || k === "space") && items[this.sel]) { items[this.sel].go(); return; }
    else if (k === "l" || k === "/") { this.startEdit(cx); return; }
    else if (k === "escape") { this.sel = -1; focusEditor(this.vm); cx.notify(); return; }
    else return;
    cx.stop_propagation?.();
    cx.notify();
  }

  startEdit(cx) {
    this.editing = true;
    this.input.set_value(this.path && this.path !== ctxFor(this.vm).root ? this.path : "");
    cx.spawn(async () => { try { this.input.focus(); } catch {} });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const vm = this.vm;
    const c = ctxFor(vm);
    if (!this.fh && !this.fhAsked) { this.fhAsked = true; cx.spawn(async (cx) => { try { this.fh = cx.focus_handle(); } catch {} cx.notify(); }); }
    if (this.wantFocus && this.fh) { this.wantFocus = false; this.sel = Math.max(0, this.sel); cx.timer.after(1, (cx) => { try { this.fh.focus(); } catch {} cx.notify(); }); } // not from render (focus() throws there)
    // Keep the editor's light/dark in step with Herdr's theme.
    const light = isLight(t);
    if (this.light !== undefined && this.light !== light) sendKeys(vm, `<Cmd>set background=${light ? "light" : "dark"}<CR>`);
    this.light = light;
    const on = termOpen(vm);
    const accentBg = `${String(t.accent).slice(0, 7)}22`;
    const items = [];
    const focusRing = (el, idx) => el.when(this.sel === idx && Boolean(this.fh?.is_focused()), (e) => e.border_1().border_color(t.accent));

    // Breadcrumbs
    const segs = this.path ? crumbs(this.path, c.root) : [{ label: c.demo ? "demo workspace" : "~", path: c.demo ? c.root : "~" }];
    const crumbEls = [];
    segs.forEach((s, i) => {
      const idx = items.length;
      const last = i === segs.length - 1;
      items.push({ go: () => gotoPath(vm, s.path) });
      if (i > 0) crumbEls.push(svg(icon("chevron-right")).flex_none().size(T.icon.sm).text_color(t.dim));
      crumbEls.push(focusRing(h_flex().id(`mp-ed-crumb-${i}`).flex_none().h(T.h.btnSm - 4).px(T.sp.xs).rounded(T.r.chip).items_center().cursor_pointer()
        .text_size(T.text.sm).text_color(last ? t.foreground : t.muted).when(last, (e) => e.font_medium())
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(s.path)
        .on_click((_e, cx) => { cx.stop_propagation(); gotoPath(vm, s.path); })
        .child(s.label), idx));
    });
    const crumbBar = h_flex().id("mp-ed-crumbs").flex_1().min_w(0).h(T.h.input).pl(T.sp.sm).pr(T.sp.xs).gap(2).items_center().rounded(T.r.ctrl)
      .bg(t.background).border_1().border_color(this.editing ? t.accent : t.border).overflow_x_scroll()
      .child(svg(icon(c.demo ? "flask" : "hard-drive")).flex_none().size(T.icon.sm).text_color(t.dim).mr(T.sp.xs))
      .when(this.editing, (el) => el.child(Input.new(this.input).flex_1().min_w(0).h(T.h.btnSm).text_size(T.text.sm).text_color(t.foreground).font_family("JetBrains Mono")))
      .when(!this.editing, (el) => el.children(crumbEls)
        .child(div().id("mp-ed-crumb-type").flex_1().min_w(T.sp.xl).h_full().cursor_text().on_click((_e, cx) => { cx.stop_propagation(); this.startEdit(cx); }).tooltip("Type a path (L)"))
        .when(Boolean(this.modified), (e) => e.child(div().flex_none().size(T.dot).mr(T.sp.xs).rounded_full().bg("#d4a35a").tooltip("Unsaved changes"))));

    const btn = (id, iconName, label, go, { active = false, tip, primary = false } = {}) => {
      const idx = items.length;
      items.push({ go });
      return focusRing(h_flex().id(id).flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).rounded(T.r.ctrl).items_center().cursor_pointer()
        .text_size(T.text.xs).font_medium().border_1().border_color(active || primary ? t.accent : t.border)
        .bg(active || primary ? accentBg : t.raised).text_color(active || primary ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground).bg(t.hover)).tooltip(tip ?? label ?? "")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); go(); })
        .child(svg(icon(iconName)).size(T.icon.sm)).when(Boolean(label), (el) => el.child(label)), idx);
    };

    const ws = h_flex().flex_none().h(T.h.btnSm).pl(T.sp.xs).pr(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
      .child(tile(vm, { kind: "vm", size: 18, radius: 5 }))
      .child(div().text_size(T.text.xs).font_medium().text_color(t.foreground).child(vm))
      .when(c.demo, (el) => el.child(div().px(T.sp.xs).rounded(T.r.chip).bg(accentBg).text_size(T.text.xs).text_color(t.accent).child("demo")));

    const row = h_flex().id("mp-ed-bar").size_full().gap(T.sp.md).items_center()
      .when(Boolean(this.fh), (el) => el.track_focus(this.fh))
      .key_context("HvEditorBar")
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (this.fh && !this.editing) this.fh.focus(); })
      .child(ws)
      .child(crumbBar)
      .when(Boolean(this.branch), (el) => el.child(h_flex().flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl)
        .text_size(T.text.xs).text_color(t.muted).bg(t.raised).border_1().border_color(t.border).tooltip("Git branch")
        .child(svg(icon("git-branch")).size(T.icon.sm).text_color(t.accent)).child(this.branch)))
      .when(Boolean(this.setup && !this.ready), (el) => el.child(h_flex().flex_none().h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl)
        .text_size(T.text.xs).text_color(t.muted).bg(t.raised).border_1().border_color(t.border).tooltip("First start: downloading the editor plugins (about 30 s). The editor continues by itself.")
        .child(svg(icon("loader")).size(T.icon.sm).text_color(t.accent).loop("opacity", { from: 0.35, to: 1, period: 1000 }))
        .child("Setting up editor plugins…")))
      .child(btn("mp-ed-files", "sidebar", "Files", () => editorAction(vm, "HvAction('tree')"), { tip: "Toggle the file tree (Ctrl+B) · Ctrl+P finds a file" }))
      .child(btn("mp-ed-search", "search", "Search", () => editorAction(vm, "HvAction('grep')"), { tip: "Search in all files (Ctrl+Alt+F) · Ctrl+F finds in the file" }))
      .child(btn("mp-ed-cmds", "list", "Commands", () => editorAction(vm, "HvAction('commands')"), { tip: "All editor commands: git, code, replace, go to line… (Ctrl+Alt+P)" }))
      .child(btn("mp-ed-term", "terminal", "Terminal", () => toggleTerminal(vm), { active: on, tip: on ? "Hide the terminal (Ctrl+`)" : c.demo ? "Show PowerShell in the workspace (Ctrl+`)" : "Show the machine's shell (Ctrl+`)" }));
    this.items = items;
    if (this.sel >= items.length) this.sel = items.length - 1;
    return row;
  }
}

// Leaving a machine's Editor tab closes its Neovim (and the SSH shell under it), so editors don't pile
// up in memory, one per machine ever opened. Unsaved files keep it open (with a note); reopening the
// tab starts a fresh editor in the same folder (g:hv_state remembers it).
export async function closeEditor(vm) {
  const c = ctxFor(vm);
  const ed = await liveTerm(c.name);
  if (ed) {
    const tools = await findTools();
    if (tools.nvim) {
      const r = await exec(tools.nvim, ["--server", c.pipe, "--remote-expr", "len(getbufinfo({'bufmodified':1}))"], { timeout: 5000 }).catch(() => null);
      const dirty = parseInt(String(r?.stdout ?? "0").trim(), 10) || 0;
      if (dirty > 0) {
        toast(`Editor on ${vm} stays open`, `${dirty} unsaved file${dirty === 1 ? "" : "s"}. Save (Ctrl+S) and leave the tab again to close it.`, "info");
        return false;
      }
    }
    run("terminal.kill", { terminal: ed.address });
  }
  const sh = await liveTerm(c.shell);
  if (sh) run("terminal.kill", { terminal: sh.address });
  await hc(["rm", c.name]).catch(() => {});
  await hc(["rm", c.shell]).catch(() => {});
  return true;
}

// Editors left running from before (one per machine ever opened): closed at start, except the one whose
// Editor tab is shown and any with unsaved files.
export async function closeStaleEditors(keepVm) {
  const keep = keepVm ? ctxFor(keepVm).name : null;
  const list = parseJson((await hc(["ls", "--all", "--json"]).catch(() => ({ stdout: "" }))).stdout)?.terminals ?? [];
  const tools = await findTools();
  let n = 0;
  for (const t of list) {
    if (!t.name || !/^edd?-/.test(t.name) || t.state !== "live" || t.name === keep) continue;
    const s = t.name.replace(/^edd?-/, "");
    const pipe = `\\\\.\\pipe\\hv-nvim-${t.name.startsWith("edd-") ? "demo-" : ""}${s}`;
    if (tools.nvim) {
      const r = await exec(tools.nvim, ["--server", pipe, "--remote-expr", "len(getbufinfo({'bufmodified':1}))"], { timeout: 5000 }).catch(() => null);
      if ((parseInt(String(r?.stdout ?? "0").trim(), 10) || 0) > 0) continue;
    }
    run("terminal.kill", { terminal: t.address });
    await hc(["rm", t.address]).catch(() => {});
    n++;
  }
  return n;
}
