// Slim 24 px IDE status bar (focusable F6 zone). Also: this computer (CPU/RAM/disk every 5 s) and every virtual machine
// (every 15 s). It also collects machine stats for the rest of the app
// (shared "mp.vmstats"), because it is always visible.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, shared, setShared, spaces, panes, run, appHome, hc, agents, window as win } from "herdr";
import * as fs from "fs/promises";
import { startAgent, toast, sleepMs } from "./lib.js";
import { demo, meter, fmtBytes, fmtTime, hpScript, loadMachines, listProjects, currentSlug, selectProject, liveAgent, loginProvider, measure, sshAlias, vmStats, vmHealth, openVm, showCenter, pct, watchData, claimJob, repeat, setSharedIf, clear, iconEl, OK, WARN, BAD } from "./lib.js";
import { limitRows, limitTip, limitColor, refreshLimits } from "./sidebar.js";

const KSM = new WeakMap();
const KS = (o) => { let s = KSM.get(o); if (!s) KSM.set(o, (s = {})); return s; };
import { liveBars } from "./charts.js";

const LOCAL_EVERY = 30000; // local CPU/RAM/disk (one PowerShell per probe); 2 min in the background
const VM_EVERY = 5 * 60 * 1000; // every machine over ssh, once per 5 min
const VM_PARALLEL = 4; // ssh probes running at once

// Two CPU/network samples 1 s apart, memory, disk "/", OS, cores, uptime.
const VM_PROBE = [
  "N() { awk '/:/ && !/ lo:/ {gsub(\":\",\" \"); r+=$2; t+=$10} END {print \"net\", r+0, t+0}' /proc/net/dev; }",
  "head -1 /proc/stat; N; sleep 1; head -1 /proc/stat; N",
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  "df -P / | tail -1 | awk '{print \"disk\", $2, $3, $4}'",
  "echo os $( . /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-$(uname -sr)} )",
  "echo cores $(nproc 2>/dev/null || echo 1)",
  "echo up $(cut -d. -f1 /proc/uptime)",
].join("; ");

export function parseProbe(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nums = (l) => l.split(/\s+/).slice(1).map(Number);
  const cpus = lines.filter((l) => /^cpu\s/.test(l)).map(nums);
  const nets = lines.filter((l) => l.startsWith("net ")).map(nums);
  let cpu = NaN, rx = NaN, tx = NaN;
  if (cpus.length >= 2) {
    const idle = (v) => (v[3] ?? 0) + (v[4] ?? 0);
    const total = (v) => v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    const dt = total(cpus[1]) - total(cpus[0]);
    cpu = dt > 0 ? 100 * (1 - (idle(cpus[1]) - idle(cpus[0])) / dt) : 0;
  }
  if (nets.length >= 2) { rx = Math.max(0, nets[1][0] - nets[0][0]); tx = Math.max(0, nets[1][1] - nets[0][1]); }
  const kb = (key) => Number((lines.find((l) => l.startsWith(key)) ?? "").split(/\s+/)[1]);
  const memTotal = kb("MemTotal:"), memAvail = kb("MemAvailable:");
  const d = nums(lines.find((l) => l.startsWith("disk ")) ?? "disk");
  const after = (k) => (lines.find((l) => l.startsWith(k + " ")) ?? "").slice(k.length + 1).trim();
  return {
    cpu, rx, tx,
    ram: memTotal > 0 ? 100 * (1 - memAvail / memTotal) : NaN,
    memTotal: memTotal * 1024, memUsed: (memTotal - memAvail) * 1024,
    disk: d[1] + d[2] > 0 ? (100 * d[1]) / (d[1] + d[2]) : NaN,
    diskTotal: d[0] * 1024, diskUsed: d[1] * 1024,
    os: after("os"), cores: Number(after("cores")) || null, uptime: Number(after("up")) || null,
  };
}

export class Status {
  init(cx) {
    this.s = null;
    this.busy = false;
    this.machines = [];
    this.stats = { ...vmStats() };
    this.history = {}; // machine -> recent CPU samples
    this.local = { cpu: [], ram: [], disk: [] };
    try { KS(this).fh = cx.focus_handle(); } catch {}
    const alive = claimJob("status");
    this.probeLocal(cx);
    repeat(cx, LOCAL_EVERY, (cx) => this.probeLocal(cx), alive);
    watchData(cx, (cx) => cx.spawn(async (cx) => {
      const before = this.machines.map((m) => m.name).join(",");
      this.machines = await loadMachines();
      this.projects = await listProjects().catch(() => []);
      if (this.machines.map((m) => m.name).join(",") !== before) this.probeVms(cx, true);
      cx.notify();
    }), 60000, "status");
    repeat(cx, 60000, (cx) => this.probeVms(cx), alive); // probeVms itself waits VM_EVERY between rounds
    // Once per change in how Herdr logs in (hp vm sync-config rewrites every "herdr-<name>" ssh block),
    // then every machine is checked again at once.
    // Editors left running from before this change: close them (not the one on screen, not unsaved ones).
    cx.timer.after(5000, () => {
      const v = shared("mp.view");
      import("./editor.js").then((m) => m.closeStaleEditors(v?.kind === "vm" && v.tab === "editor" ? v.name : null)).catch(() => {});
    });
    // Once after a change in the agents' contract (AGENTS.md rule 9: questions / permissions via the Mailbox):
    // regenerate every project's AGENTS.md.
    if (!demo() && shared("mp.docsVer") !== 19) {
      cx.spawn(async () => {
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hpScript(), "project", "docs", "--all"], { timeout: 120000 }).catch(() => null);
        if (r?.code === 0) setShared("mp.docsVer", 19);
      });
    }
    // One-time "restart every running agent" (so they read the regenerated AGENTS.md): requested by the file
    // data/hyper-view/restart-agents.json; whoever deletes it first does the restart, exactly once.
    if (!demo()) cx.timer.after(20000, (cx) => cx.spawn(async () => {
      const req = `${String(appHome()).replace(/\\/g, "/").replace(/\/+$/, "")}/data/hyper-view/restart-agents.json`;
      let only = null; // { "projects": ["slug", …] } restarts only those projects' agents
      let all = false; // { "all": true }: also start the ones not running (and close their dead shells)
      try { const j = JSON.parse(await fs.readFile(req, "utf8")); only = j?.projects ?? null; all = Boolean(j?.all); } catch {}
      try { await fs.unlink(req); } catch { return; }
      const sup = await import("./supervisor.js");
      const list = [];
      for (const p of await listProjects().catch(() => [])) for (const a of Array.isArray(only) && !only.includes(p.slug) ? [] : p.agents ?? []) {
        const live = liveAgent(p, a.name);
        if (!live && !all) continue;
        sup.markManualStop(p.slug, a.name);
        if (live) run("terminal.kill", { terminal: live.address });
        list.push([p, a]);
      }
      if (all) {
        // Shells left from a start that failed (Codex exited, PowerShell stayed): closed, so no duplicate tabs.
        const ls = await hc(["ls", "--all", "--json"]).catch(() => null);
        let terms = [];
        try { terms = JSON.parse(ls?.stdout ?? "")?.terminals ?? []; } catch {}
        for (const t of terms) if (t.state === "live" && /powershell/i.test(t.agent ?? "") && list.some(([p, a]) => t.where === `${p.name} / ${a.name}`)) run("terminal.kill", { terminal: t.address });
      }
      await sleepMs(3000);
      for (const [p, a] of list) {
        sup.resetRestarts(p.slug, a.name);
        startAgent(p, a, `You were restarted so you work by the updated AGENTS.md (read it again). Run: hp task list --as ${a.name}, hp inbox --as ${a.name}, then continue your In Progress task (or start the next To Do).`, { quiet: true });
        await sleepMs(1500);
      }
      toast("Agents restarted", `${list.length} agent${list.length === 1 ? "" : "s"} restarted with the new instructions.`, "success");
    }));
    // Diagnostics on request (v7) (data/hyper-view/diag.json { "mcp": "<server>", "agent": "<terminal tab name>" }):
    // the agent terminal's last screen and one MCP initialize through the Codex shim, to diag-out.json.
    // Lines that could carry a token are dropped.
    if (!demo()) cx.timer.after(12000, (cx) => cx.spawn(async () => {
      const dir = `${String(appHome()).replace(/\\/g, "/").replace(/\/+$/, "")}/data/hyper-view`;
      let req = null;
      try { req = JSON.parse(await fs.readFile(`${dir}/diag.json`, "utf8")); await fs.unlink(`${dir}/diag.json`); } catch { return; }
      const clean = (x) => String(x ?? "").split(/\r?\n/).filter((l) => !/bearer|authorization|token|secret|password/i.test(l)).join("\n").slice(-12000);
      const out = { at: new Date().toISOString() };
      try {
        const a = (agents() ?? []).find((x) => x.tab_name === req.agent);
        out.agent = a ? { status: a.status, address: a.address } : "not found";
        out.all = (agents() ?? []).map((x) => [x.space_name, x.tab_name, x.status, x.address]);
        if (req.addr) { const r = await hc(["read", req.addr]).catch((e) => ({ stdout: String(e) })); out.addrScreen = clean(r?.stdout ?? r); }
        if (req.lsAll) { const r = await hc(["ls", "--all", "--json"]).catch((e) => ({ stdout: String(e) })); out.ls = clean(r?.stdout ?? "").slice(0, 8000); }
        if (a) { const r = await hc(["read", a.address]).catch((e) => ({ stdout: String(e) })); out.screen = clean(r?.stdout ?? r); }
      } catch (e) { out.agentErr = String(e?.message ?? e); }
      if (req.mcp) {
        const shim = `${String(appHome()).replace(/\//g, "\\")}\\data\\hyper-view\\mcp\\${req.mcp}.cmd`;
        const ps = `$init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag","version":"1"}}}'; ` +
          `$psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName='cmd.exe'; $psi.Arguments='/d /c ""${shim}""'; $psi.UseShellExecute=$false; ` +
          `$psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $p=[Diagnostics.Process]::Start($psi); ` +
          `$p.StandardInput.WriteLine($init); $p.StandardInput.Flush(); $o=$p.StandardOutput.ReadLineAsync(); $e=$p.StandardError.ReadToEndAsync(); ` +
          `$ok=$o.Wait(90000); Write-Output ('STDOUT: ' + $(if ($ok) { $o.Result } else { '(no answer in 90 s)' })); ` +
          `try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch {}; if ($e.Wait(3000)) { Write-Output ('STDERR: ' + $e.Result) }`;
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 120000 }).catch((e) => ({ stdout: "", stderr: String(e?.message ?? e) }));
        out.mcp = clean(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
      }
      await fs.writeFile(`${dir}/diag-out.json`, JSON.stringify(out, null, 1)).catch(() => {});
    }));
    if (!demo() && shared("mp.sshCfgVer") !== 2) {
      cx.spawn(async (cx) => {
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hpScript(), "vm", "sync-config"], { timeout: 60000 }).catch(() => null);
        if (r?.code === 0) { setShared("mp.sshCfgVer", 2); this.machines = await loadMachines(); this.probeVms(cx, true); }
      });
    }
  }

  probeLocal(cx) {
    if (this.busy) return;
    // Each probe starts PowerShell: every 30 s while the window is active, every 2 min otherwise.
    let active = true;
    try { active = win().active !== false; } catch {}
    if (!active && Date.now() - (this.localAt ?? 0) < 120000) return;
    this.localAt = Date.now();
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hpScript(), "stats"], { timeout: 15000 });
        const [cpu, ramUsed, ramTotal, diskUsed, diskTotal] = r.stdout.trim().split("|").map(Number);
        if (r.code === 0 && Number.isFinite(cpu)) {
          this.s = { cpu, ramUsed, ramTotal, diskUsed, diskTotal };
          const push = (k, v) => { this.local[k].push(v); if (this.local[k].length > 30) this.local[k].shift(); };
          push("cpu", cpu); push("ram", (100 * ramUsed) / ramTotal); push("disk", (100 * diskUsed) / diskTotal);
        }
      } catch {}
      this.busy = false;
      cx.notify();
    });
  }

  probeVms(cx, force = false) {
    const names = new Set(this.machines.map((m) => m.name));
    for (const k of Object.keys(this.stats)) if (!names.has(k)) delete this.stats[k];
    let left = this.machines.length;
    if (!left) { setSharedIf("mp.vmstats", {}); return; }
    // One round of ssh probes at a time (a slow or hanging machine must not stack rounds).
    if (!force && this.vmBusy && Date.now() - this.vmBusy < 30000 + this.machines.length * 1000) return;
    // A round every VM_EVERY (5 min), at most VM_PARALLEL ssh processes at once. `force`: the machine
    // list changed, probe now (new machines get stats at once).
    if (!force && this.vmAt && Date.now() - this.vmAt < VM_EVERY - 1000) return;
    this.vmAt = Date.now();
    this.vmBusy = Date.now();
    const queue = [...this.machines];
    const worker = (cx) => {
      const m = queue.shift();
      if (!m) return;
      cx.spawn(async (cx) => {
        let st;
        try {
          const r = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshAlias(m.name), VM_PROBE], { timeout: 14000 });
          st = r.code === 0 ? { ...parseProbe(r.stdout), ok: true } : { ok: false, err: (r.stderr || "").trim().split("\n").pop() || `exit code ${r.code}` };
        } catch (e) {
          st = { ok: false, err: String(e?.message ?? e) };
        }
        const h = (this.history[m.name] ??= []);
        if (st.ok) { h.push(Math.round(st.cpu)); if (h.length > 40) h.shift(); }
        this.stats[m.name] = { ...st, at: Date.now(), cpuHistory: [...h] };
        if (--left === 0) { this.vmBusy = 0; setSharedIf("mp.vmstats", { ...this.stats }, ["at"]); cx.notify(); }
        worker(cx);
      });
    };
    for (let i = 0; i < VM_PARALLEL; i++) worker(cx);
  }

  // Slim 24 px IDE status bar (VS Code: F6 lands here, ←/→ move between entries, Enter runs one).
  // Left: current project · branch · agents working. Right: waiting, CPU/RAM/disk, machines, usage limits, keys.
  items(t) {
    const s = this.s;
    const ratio = (a, b) => (b > 0 ? (100 * a) / b : NaN);
    const st = shared("mp.storage");
    const storeTip = st?.ok ? `Herdr data (~/.herdr): ${fmtBytes(st.bytes)}`
      + `\nEvents database ${fmtBytes(st.parts?.db ?? 0)} · projects ${fmtBytes(st.parts?.projects ?? 0)} · editor plugins ${fmtBytes(st.parts?.nvim ?? 0)}`
      + `\nLast cleanup at ${fmtTime(st.at)} (old events archived, logs capped, temp files removed; every 6 h)`
      : "Herdr data size: checking…";
    const slug = currentSlug();
    const p = (this.projects ?? []).find((x) => x.slug === slug);
    const name = p ? (p.loose ? p.agents?.[0]?.name ?? p.name : p.name) : null;
    let branch = null;
    try {
      const sp = spaces().find((x) => x.named && x.name === p?.name);
      const ps = panes().filter((x) => sp?.tabs?.some((tb) => tb.id === x.tab));
      branch = (ps.find((x) => x.focused) ?? ps.find((x) => x.branch))?.branch ?? null;
    } catch {}
    const working = p ? p.agents.map((a) => liveAgent(p, a.name)).filter((a) => a?.status === "working").length : 0;
    const waiting = (shared("mp.waiting") ?? []).length;
    const stats = demo() ? vmStats() : this.stats;
    const offline = this.machines.filter((m) => { const x = stats[m.name]; return x && !x.ok; }).map((m) => m.name);
    const out = [];
    out.push({ id: "proj", side: "l", icon: "git-branch", text: name ? `${name}${branch ? ` · ${branch}` : ""}` : "No project", tip: name ? `${name}${branch ? `\nBranch ${branch}` : ""}\nEnter: open project` : "Open a project",
      go: () => { if (p) { selectProject(p.slug, p.loose ? "overview" : undefined); showCenter("mp-view"); } } });
    if (p && !p.loose) out.push({ id: "work", side: "l", dot: working ? OK : t.dim, text: `${working} working`, tip: "Agents working · Enter: Agents tab", go: () => { selectProject(p.slug, "agents"); showCenter("mp-view"); } });
    out.push({ id: "wait", side: "r", dot: waiting ? WARN : null, color: waiting ? WARN : t.dim, text: waiting ? `${waiting} waiting` : "0 waiting", tip: "Agents waiting for you · Enter: jump (Ctrl+J)",
      go: () => import("./attention.js").then((m) => m.jumpNextWaiting()) });
    const meterItem = (id, label, v, color, tip) => ({ id, side: "r", text: `${label} ${pct(v)}`, bars: [this.local[id], color], tip, go: () => {} });
    out.push(meterItem("cpu", "CPU", s?.cpu, t.accent, "This computer: CPU"));
    out.push(meterItem("ram", "RAM", s ? ratio(s.ramUsed, s.ramTotal) : NaN, "#7fa9cf", "This computer: memory"));
    out.push(meterItem("disk", "Disk", s ? ratio(s.diskUsed, s.diskTotal) : NaN, OK, storeTip));
    out.push({ id: "vms", side: "r", icon: "server", dot: offline.length ? BAD : this.machines.length ? OK : t.dim, text: `${this.machines.length - offline.length}/${this.machines.length} online`,
      tip: offline.length ? `Offline: ${offline.join(", ")}\nEnter: open ${offline[0]}` : "Machines online · Enter: Machines explorer",
      go: () => { if (offline.length) { openVm(offline[0]); showCenter("mp-view"); } else { setShared("mp.explorer", "vms"); setShared("mp.focus", { to: "sidebar", reveal: "vms", at: Date.now() }); } } });
    for (const r of limitRows()) {
      const main = r.wins[0]?.[1];
      const signedOut = r.signedOut;
      out.push({ id: `lim-${r.key}`, side: "r", dot: r.color, text: `${r.name} ${signedOut ? "log in" : main ? `${Math.round(main.pct)}%` : "–"}`, color: signedOut ? WARN : main ? limitColor(main.pct, t) : t.dim,
        tip: `${r.name} usage left\n${limitTip(r)}\nEnter: ${signedOut ? "log in" : "refresh"}`, go: () => (signedOut ? loginProvider(r.key) : refreshLimits()) });
    }
    out.push({ id: "keys", side: "r", icon: "list", text: "F6", tip: "Keyboard: F6 / Shift+F6 cycle zones · Ctrl+/ shortcuts", go: () => import("./palette.js").then((m) => m.openPaletteWith({ mode: "keys" })) });
    return out;
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || !KS(this).fh?.is_focused()) return;
    const ids = (KS(this).items ?? []).map((x) => x.id);
    let i = Math.max(0, ids.indexOf(this.sel));
    if (k === "right" || k === "l") i = Math.min(ids.length - 1, i + 1);
    else if (k === "left" || k === "h") i = Math.max(0, i - 1);
    else if (k === "home") i = 0;
    else if (k === "end") i = ids.length - 1;
    else if (k === "enter" || k === "space") KS(this).items?.[i]?.go();
    else if (k === "escape" || k === "up") setShared("mp.focus", { to: "view", at: Date.now() });
    else return;
    this.sel = ids[i];
    cx.stop_propagation();
    cx.notify();
  }

  // One machine right away (shared "mp.vmProbeAsk" = { vm, at }: after a password / key change, "Check now").
  probeOne(cx, name) {
    const m = this.machines.find((x) => x.name === name);
    if (!m) return;
    cx.spawn(async (cx) => {
      let st;
      try {
        const r = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshAlias(m.name), VM_PROBE], { timeout: 14000 });
        st = r.code === 0 ? { ...parseProbe(r.stdout), ok: true } : { ok: false, err: (r.stderr || "").trim().split("\n").pop() || `exit code ${r.code}` };
      } catch (e) { st = { ok: false, err: String(e?.message ?? e) }; }
      const h = (this.history[m.name] ??= []);
      if (st.ok) { h.push(Math.round(st.cpu)); if (h.length > 40) h.shift(); }
      this.stats[m.name] = { ...st, at: Date.now(), cpuHistory: [...h] };
      setSharedIf("mp.vmstats", { ...this.stats }, ["at"]);
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    // The machine editor lives only while its Editor tab is shown (editor.js closeEditor).
    const v = shared("mp.view");
    const edKey = v?.kind === "vm" && v.tab === "editor" ? v.name : null;
    if (this.edOpen && this.edOpen !== edKey) {
      const vm = this.edOpen;
      cx.timer.after(1, () => { import("./editor.js").then((m) => m.closeEditor(vm)).catch(() => {}); });
    }
    this.edOpen = edKey;
    const ask = shared("mp.vmProbeAsk");
    if (ask?.at && ask.at !== this.probeAskAt) { this.probeAskAt = ask.at; if (Date.now() - ask.at < 30000) cx.timer.after(1, (cx) => this.probeOne(cx, ask.vm)); }
    if (!KS(this).fh && !KS(this).asked) { KS(this).asked = true; cx.timer.after(1, (cx) => { try { KS(this).fh = cx.focus_handle(); } catch {} cx.notify(); }); }
    const fr = shared("mp.focus");
    if (KS(this).fh && fr && fr.at !== this.focusAt) {
      this.focusAt = fr.at;
      if (fr.to === "status" && Date.now() - fr.at < 3000) { globalThis.__hvZone = "status"; cx.timer.after(1, (cx) => { KS(this).fh.focus(); cx.notify(); cx.timer.after(60, (cx) => cx.notify()); }); }
    }
    if (KS(this).fh) (globalThis.__hvFH ??= {}).status = KS(this).fh;
    const kbOn = Boolean(KS(this).fh?.is_focused?.());
    const items = this.items(t);
    KS(this).items = items;
    if (!items.some((x) => x.id === this.sel)) this.sel = items[0]?.id;
    const cell = (x) => h_flex().id(`mp-sb-${x.id}`).flex_none().h(20).px(T.sp.sm).gap(T.sp.xs).items_center().rounded(T.r.chip).cursor_pointer()
      .border_1().border_color(kbOn && this.sel === x.id ? t.accent : clear)
      .hover((s) => s.bg(t.hover)).tooltip(x.tip)
      .on_mouse_down("left", (_e, cx) => { this.sel = x.id; cx.notify(); })
      .on_click(() => x.go())
      .when(Boolean(x.icon), (el) => el.child(iconEl(x.icon, t.dim, 12)))
      .when(Boolean(x.dot), (el) => el.child(div().flex_none().size(T.dot).rounded_full().bg(x.dot)))
      .child(div().text_size(T.text.xs).text_color(x.color ?? t.muted).child(x.text))
      .when(Boolean(x.bars), (el) => el.child(liveBars(`mp-sb-bars-${x.id}`, x.bars[0]?.length > 1 ? x.bars[0] : [0, 0], x.bars[1], 20, 10, { max: 100 })));
    return h_flex().id("mp-status").size_full().pl(T.sp.sm).pr(T.sp.sm).gap(T.sp.xxs).items_center().bg(t.chrome).border_t_1().border_color(t.border)
      .when(Boolean(KS(this).fh), (el) => el.track_focus(KS(this).fh)).key_context("HvStatus").on_key_down((e, cx) => this.key(e, cx))
      .on_size_change(measure("status"))
      .children(items.filter((x) => x.side === "l").map(cell))
      .child(div().flex_1().min_w(0))
      .children(items.filter((x) => x.side === "r").map(cell));
  }
}
