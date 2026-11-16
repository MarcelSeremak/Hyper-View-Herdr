// Slim 24 px IDE status bar (focusable F6 zone). Also: this computer (CPU/RAM/disk every 5 s) and every virtual machine
// (every 15 s). It also collects machine stats for the rest of the app
// (shared "mp.vmstats"), because it is always visible.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, shared, setShared, spaces, panes, window as win } from "herdr";
import { demo, meter, fmtBytes, fmtTime, hpScript, loadMachines, listProjects, currentSlug, selectProject, liveAgent, loginProvider, measure, sshAlias, vmStats, vmHealth, openVm, showCenter, pct, watchData, claimJob, repeat, setSharedIf, clear, iconEl, OK, WARN, BAD } from "./lib.js";
import { limitRows, limitTip, limitColor, refreshLimits } from "./sidebar.js";

const KSM = new WeakMap();
const KS = (o) => { let s = KSM.get(o); if (!s) KSM.set(o, (s = {})); return s; };
import { liveBars } from "./charts.js";

const LOCAL_EVERY = 5000;
const VM_EVERY = 15000;

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
      if (this.machines.map((m) => m.name).join(",") !== before) this.probeVms(cx);
      cx.notify();
    }), 10000, "status");
    repeat(cx, VM_EVERY, (cx) => this.probeVms(cx), alive);
  }

  probeLocal(cx) {
    if (this.busy) return;
    // Each probe starts PowerShell: every 5 s while the window is active, every 30 s otherwise.
    let active = true;
    try { active = win().active !== false; } catch {}
    if (!active && Date.now() - (this.localAt ?? 0) < 30000) return;
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

  probeVms(cx) {
    const names = new Set(this.machines.map((m) => m.name));
    for (const k of Object.keys(this.stats)) if (!names.has(k)) delete this.stats[k];
    let left = this.machines.length;
    if (!left) { setSharedIf("mp.vmstats", {}); return; }
    // One round of ssh probes at a time (a slow or hanging machine must not stack rounds).
    if (this.vmBusy && Date.now() - this.vmBusy < 30000) return;
    this.vmBusy = Date.now();
    for (const m of this.machines) {
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
        if (--left === 0) { this.vmBusy = 0; setSharedIf("mp.vmstats", { ...this.stats }, ["at"]); }
        cx.notify();
      });
    }
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
      const signedOut = Boolean(r.err) && r.err !== "Checking…";
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

  render(cx) {
    const t = theme();
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
