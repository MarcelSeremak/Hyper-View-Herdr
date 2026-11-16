// Machine view: Overview, Metrics, Editor (editor.js), Access, Settings.
import { cardHead as cardHeader, section, emptyLine } from "./ide.js";
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  vmStats, selectProject, button, meter, pill, card, empty, tile, iconEl,
  fmtBytes, pct, hpCmd, installKey, grid, gridCols, sshAlias, OK, WARN, BAD, INFO, colorFor, agentAvatar, liveAgent,
  splitRow, sideCol, lockOf, lockTip, openVm, loadMachines, loadLocks, vmHealth, clear, demo,
} from "./lib.js";
import { shared } from "herdr";
import { spark, heatGrid, loadColor, legend } from "./charts.js";
import { openForm, switchEl } from "./form.js";

const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
function uptime(s) {
  if (!s) return "–";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const rate = (b) => (Number.isFinite(b) ? `${fmtBytes(b)}/s` : "–");

// Metric cell of a stat strip (no card of its own): label + value on one line, chart or meter, a dim note.
function metric(ws, t, id, iconName, color, label, value, sub, v, history, n = 4) {
  const w = Math.max(100, Math.floor((ws.contentW() - 2) / (ws.contentW() >= 720 ? n : 2)) - 2 * T.pad.card);
  return v_flex().id(id).flex_1().min_w(0).h(100).px(T.pad.card).py(T.sp.md).gap(T.sp.xs)
    .child(h_flex().gap(T.sp.md).items_baseline()
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(label))
      .child(div().flex_none().text_size(T.text.lg).font_semibold().child(value)))
    .when(history != null, (el) => el.child(spark(`${id}-h`, history, color, w, 26)))
    .when(v !== undefined, (el) => el.child(div().pt(T.sp.md).child(meter(t, v, color, 4))))
    .child(div().flex_1())
    .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(sub ?? ""));
}
// Cells in one bordered panel split by 1px dividers (two rows of two when narrow).
function strip(ws, t, id, cells) {
  const per = ws.contentW() >= 720 ? cells.length : 2;
  const rows = [];
  for (let i = 0; i < cells.length; i += per) rows.push(cells.slice(i, i + per));
  return v_flex().id(id).w_full().rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
    .children(rows.map((r, ri) => h_flex().id(`${id}-r${ri}`).w_full().when(ri > 0, (e) => e.border_t_1().border_color(t.border))
      .children(r.map((c, ci) => (ci > 0 ? c.border_l_1().border_color(t.border) : c)))));
}

export function vmView(ws, t, v) {
  const m = ws.machines.find((x) => x.name === v.name);
  if (!m) return card(t, "mp-vm-missing").child(empty(t, `Machine ${v.name} does not exist.`));
  const st = vmStats()[m.name];
  const attached = ws.projects.filter((p) => p.machines.includes(m.name));
  const projects = attached.filter((p) => !p.loose);
  const agents = attached.flatMap((p) => p.agents.filter((a) => !arr(a.machines).length || arr(a.machines).includes(m.name)).map((a) => ({ a, p })));
  const tab = v.tab ?? "overview";
  const hist = st?.cpuHistory ?? [];

  const netMetric = (id) => metric(ws, t, id, "network", INFO, "Network", st?.ok ? rate((st.rx ?? 0) + (st.tx ?? 0)) : "–", st?.ok ? `↓ ${rate(st.rx)}  ·  ↑ ${rate(st.tx)}` : "");

  if (tab === "metrics") {
    return v_flex().gap(16)
      .child(card(t, "mp-vm-cpu").child(cardHeader(t, "CPU"))
        .child(div().px(12).pb(12).child(spark(`vm-cpu-big-${m.name}`, hist, t.accent, Math.max(300, ws.width - 82), 140, { max: 100 }))))
      .child(strip(ws, t, "mp-vm-mg", [metric(ws, t, "mp-vm-m-ram", "memory", INFO, "Memory", pct(st?.ram), st?.ok ? `${fmtBytes(st.memUsed)} of ${fmtBytes(st.memTotal)}` : "", st?.ram),
        metric(ws, t, "mp-vm-m-disk", "hard-drive", WARN, "Disk", pct(st?.disk), st?.ok ? `${fmtBytes(st.diskUsed)} of ${fmtBytes(st.diskTotal)}` : "", st?.disk),
        netMetric("mp-vm-m-net")]));
  }

  if (tab === "access") {
    return v_flex().gap(16)
      .child(card(t, "mp-vm-ssh").child(cardHeader(t, "SSH & sudo"))
        .child(v_flex().px(12).pb(12).gap(12)
          // The login user's sudo rights: on/off per machine. Agents still need sudo granted per machine.
          .child(h_flex().gap(8).items_center()
            .child(switchEl(t, "mp-vm-sudo-sw", Boolean(m.sudo), (cx) => ws.act(cx, ["vm", "set", m.name], { sudo: m.sudo ? "off" : "on" }, m.sudo ? "Sudo turned off" : "Sudo turned on")))
            .child(div().text_size(T.text.sm).child(`Sudo access${m.sudo ? ` — ${m.user} can use sudo` : " is off"}`)))
          .child(h_flex().gap(8).items_center().child(div().size(T.dot).rounded_full().bg(st?.ok ? OK : st ? BAD : t.dim))
            .child(div().text_size(T.text.sm).child(st?.ok ? "Key-based login works." : st ? `Key login failed: ${st.err ?? ""}` : "Checking…")))
          .child(h_flex().gap(8).flex_wrap()
            .child(button(t, "mp-vm-ssh-pw", "Change SSH Password", () => openForm("vm-password", { machine: m.name, user: m.user }), { small: true, iconName: "key" }))
            .child(button(t, "mp-vm-trust", "Install SSH Key", () => installKey(m.name), { small: true, iconName: "terminal" })))))
      .child(card(t, "mp-vm-proj").child(cardHeader(t, "Attached to"))
        .child(h_flex().px(12).pb(12).gap(8).flex_wrap()
          .when(ws.projects.length === 0, (el) => el.child(div().text_size(T.text.sm).text_color(t.dim).child("No projects yet.")))
          .children([...ws.projects.filter((p) => !p.loose), ...ws.projects.filter((p) => p.loose)].map((p) => {
            const on = p.machines.includes(m.name);
            return h_flex().id(`mp-vm-p-${p.slug}`).h(T.h.btnSm).px(T.sp.md).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.sm)
              .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
              .tooltip(on ? "Click to detach" : "Click to attach")
              .on_click((_e, cx) => ws.act(cx, ["project", on ? "detach" : "attach", m.name], { p: p.slug }))
              .child(p.loose ? tile(p.name, { size: 14, glyph: "bot", radius: 7 }) : tile(p.name, { kind: "project", size: 14, color: p.color }))
              .child(p.loose ? `${p.agents[0]?.name ?? p.name} (agent)` : p.name)
            .when(on, (el) => el.child(iconEl("check", t.accent, 12)));
          }))))
      .child(card(t, "mp-vm-agents").child(cardHeader(t, `Agents with access (${agents.length})`))
        .child(v_flex().px(12).pb(12)
          .when(agents.length === 0, (el) => el.child(emptyLine(t, "mp-vm-a-empty", "No agent can use this machine.")))
          .children(agents.map(({ a, p }, i) => h_flex().id(`mp-vm-a-${i}`).h(T.h.rowDense).gap(8).items_center()
            .child(agentAvatar(t, a.name, liveAgent(p, a.name), 18))
            .child(div().flex_1().text_size(T.text.sm).child(a.name))
            .when((a.sudo ?? []).includes(m.name), (el) => el.child(div().text_size(T.text.xs).text_color(WARN).child("sudo")))
            .child(div().text_size(T.text.xs).text_color(t.muted).child(p.loose ? "loose agent" : p.name))))));
  }

  // overview
  return v_flex().gap(16)
    .child(strip(ws, t, "mp-vm-og", [metric(ws, t, "mp-vm-o-cpu", "cpu", t.accent, "CPU", pct(st?.cpu), st?.cores ? `${st.cores} cores` : "", undefined, hist.slice(-24)),
      metric(ws, t, "mp-vm-o-ram", "memory", INFO, "Memory", pct(st?.ram), st?.ok ? `${fmtBytes(st.memUsed)} / ${fmtBytes(st.memTotal)}` : "", st?.ram),
      metric(ws, t, "mp-vm-o-disk", "hard-drive", WARN, "Disk", pct(st?.disk), st?.ok ? `${fmtBytes(st.diskTotal - st.diskUsed)} free` : "", st?.disk),
      netMetric("mp-vm-o-net")]))
    .child(splitRow(ws.contentW())
      .child(card(t, "mp-vm-info").flex_1().min_w(0).child(cardHeader(t, "Machine"))
        .child(v_flex().px(12).pb(12)
          .when(Boolean(st?.err), (el) => el.child(ws.metaRow(t, "Error", st.err, BAD)))
          .when(Boolean(lockOf(m.name)), (el) => el.child(ws.metaRow(t, "Locked", lockOf(m.name) ? lockTip(lockOf(m.name)).replace(/^Locked by /, "by ") : "", WARN)))
          .child(ws.metaRow(t, "OS", st?.os || m.os || "–"))
          .child(ws.metaRow(t, "Address", `${m.user}@${m.host}:${m.port ?? 22}`))
          .child(ws.metaRow(t, "SSH alias", sshAlias(m.name)))
          .child(ws.metaRow(t, "Sudo", m.sudo ? `On for ${m.user}` : "Off"))
          .child(ws.metaRow(t, "Uptime", uptime(st?.uptime)))
          .when(Boolean(m.desc), (el) => el.child(ws.metaRow(t, "Description", m.desc)))))
      .child(sideCol(card(t, "mp-vm-rel"), ws.contentW(), 340).child(cardHeader(t, `Projects (${projects.length})`))
        .child(v_flex().px(12).pb(12)
          .when(projects.length === 0, (el) => el.child(emptyLine(t, "mp-vm-ov-p-empty", "Not attached to a project.", ["Attach", () => openVm(m.name, "access")])))
          .children(projects.map((p) => h_flex().id(`mp-vm-ov-p-${p.slug}`).h(T.h.rowDense).px(T.sp.sm).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => selectProject(p.slug, "overview"))
            .child(tile(p.name, { kind: "project", size: 16, color: p.color })).child(div().flex_1().text_size(T.text.sm).child(p.name)))))
        .child(div().px(12).child(section(t, "Agents with access", { count: agents.length })))
        .child(v_flex().px(12).pb(12).children(agents.map(({ a, p }, i) => h_flex().id(`mp-vm-ov-a-${i}`).h(T.h.rowDense).px(T.sp.sm).gap(8).items_center()
          .child(agentAvatar(t, a.name, liveAgent(p, a.name), 16)).child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).child(a.name))
          .child(div().text_size(T.text.xs).text_color(t.dim).child(p.loose ? "loose" : p.name)))))));
}

// ------------------------------------------------------------ machines overview (view { kind: "machines" })
// The fleet at a glance, built for 80+ machines: a heat grid (one square per machine, colored by CPU —
// Datadog's host map), then a dense sortable table (Linear/Zed 32px rows) with search, status filters,
// grouping by project or name prefix and "Show more" pages of 24.
const PAGE = 24;
const MS = (globalThis.__hvMachinesOv ??= { at: 0, loading: 0, list: [], q: "", status: "all", group: "none", sort: "name", dir: 1, limit: PAGE, closed: {}, input: null, many: null });
function msRefresh(cx) {
  MS.loading = Date.now();
  cx.spawn(async (cx) => {
    try { MS.list = await loadMachines(); await loadLocks().catch(() => {}); } catch {}
    MS.at = Date.now(); MS.loading = 0; cx.notify();
  });
}
function msInput() {
  if (!MS.input) {
    MS.input = InputState.new({ placeholder: "Search machines, hosts, projects" });
    MS.input.on("change", (_e, cx) => { MS.q = MS.input.value().trim().toLowerCase(); MS.limit = PAGE; cx.notify(); });
  }
  return MS.input;
}
const prefixOf = (name) => String(name).replace(/[-_]?\d+$/, "") || name;
const HOT = 80;
const STATUS = [
  ["all", "All", () => true],
  ["online", "Online", (r) => r.st?.ok],
  ["offline", "Offline", (r) => r.st && !r.st.ok],
  ["hot", "High CPU", (r) => r.st?.ok && r.st.cpu >= HOT],
  ["locked", "Locked", (r) => Boolean(r.lock)],
];
// Mini usage bar + number (CPU / RAM / disk cells).
function usage(t, v, w) {
  const ok = Number.isFinite(v);
  const c = !ok ? t.dim : v >= 90 ? BAD : v >= 75 ? WARN : t.muted;
  return h_flex().flex_none().w(w).gap(T.sp.md).items_center()
    .child(div().flex_1().h(4).rounded_full().bg(t.hover).overflow_hidden().when(ok, (e) => e.child(div().h_full().w(`${Math.max(2, Math.min(100, v))}%`).rounded_full().bg(v >= 75 ? c : loadColor(Math.min(v, 69), t)))))
    .child(div().flex_none().w(32).text_right().text_size(T.text.xs).text_color(ok && v >= 75 ? c : t.muted).child(ok ? `${Math.round(v)}%` : "–"));
}
export function machinesOverview(ws, t, cx) {
  const manyKey = `${demo()}:${Boolean(shared("mp.demoMany"))}`;
  if ((Date.now() - MS.at > 5000 && (!MS.loading || Date.now() - MS.loading > 30000)) || MS.many !== manyKey) { MS.many = manyKey; msRefresh(cx); }
  // InputState cannot be created during render: make it in a task, then draw the field.
  if (!MS.input && !MS.inputAsked) { MS.inputAsked = true; cx.spawn(async (cx) => { msInput(); cx.notify(); }); }
  const machines = MS.at ? MS.list : ws.machines ?? [];
  const stats = vmStats();
  const bySlug = new Map((ws.projects ?? []).map((p) => [p.slug, p]));
  const rows = machines.map((m) => {
    const st = stats[m.name];
    const projects = (m.demoProjects ?? (ws.projects ?? []).filter((p) => !p.loose && p.machines.includes(m.name)).map((p) => p.slug)).map((s) => bySlug.get(s) ?? { slug: s, name: s }).filter(Boolean);
    return { m, st, health: vmHealth(st), projects, lock: lockOf(m.name) };
  });
  const counts = Object.fromEntries(STATUS.map(([k, , f]) => [k, rows.filter(f).length]));
  const q = MS.q;
  const filt = STATUS.find(([k]) => k === MS.status)?.[2] ?? (() => true);
  const shown = rows.filter((r) => filt(r) && (!q || `${r.m.name} ${r.m.host ?? ""} ${r.st?.os ?? r.m.os ?? ""} ${r.projects.map((p) => p.name).join(" ")}`.toLowerCase().includes(q)));
  const val = (r) => {
    switch (MS.sort) {
      case "cpu": return r.st?.ok ? r.st.cpu : -1;
      case "ram": return r.st?.ok ? r.st.ram : -1;
      case "disk": return r.st?.ok ? r.st.disk : -1;
      case "status": return r.st?.ok ? (r.health[0] === "Degraded" ? 1 : 2) : 0;
      default: return null;
    }
  };
  shown.sort((a, b) => { const va = val(a), vb = val(b); return (va == null ? a.m.name.localeCompare(b.m.name) : va - vb || a.m.name.localeCompare(b.m.name)) * MS.dir; });
  // Groups (by first project or name prefix), largest first; "none" = one flat list.
  const groups = new Map();
  for (const r of shown) {
    const g = MS.group === "project" ? (r.projects[0]?.name ?? "No project") : MS.group === "prefix" ? prefixOf(r.m.name) : "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const G = [...groups.entries()].sort((a, b) => (MS.group === "none" ? 0 : b[1].length - a[1].length || a[0].localeCompare(b[0])));

  const cw = ws.contentW();
  const showProj = cw >= 980, showDisk = cw >= 760, showRam = cw >= 640;
  const online = counts.online, offline = counts.offline;
  const okSt = rows.filter((r) => r.st?.ok);
  const avg = (k) => (okSt.length ? Math.round(okSt.reduce((s, r) => s + (r.st[k] ?? 0), 0) / okSt.length) : null);
  const fullDisks = okSt.filter((r) => r.st.disk >= 85).length;

  // Header + summary
  const header = h_flex().w_full().gap(T.sp.lg).items_baseline()
    .child(div().flex_none().text_size(T.text.xl).font_semibold().child("Machines"))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted)
      .child(`${rows.length} machines · ${online} online${counts.hot ? ` · ${counts.hot} high CPU` : ""}${offline ? ` · ${offline} offline` : ""}${counts.locked ? ` · ${counts.locked} locked` : ""}`))
    .child(button(t, "mp-mo-add", "Add Machine", () => openForm("vm-add", {}), { small: true, iconName: "plus" }));

  // Heat grid: every machine, grouped order, colored by CPU; offline = outlined red.
  const heatRows = G.flatMap(([, rs]) => rs).concat(rows.filter((r) => !shown.includes(r)));
  const cells = heatRows.map((r) => ({
    key: r.m.name,
    color: !r.st ? t.raised : r.st.ok ? loadColor(r.st.cpu, t) : `${BAD}33`,
    outline: r.st && !r.st.ok ? BAD : r.lock ? WARN : null,
    tip: `${r.m.name} · ${r.st?.ok ? `CPU ${Math.round(r.st.cpu)}% · RAM ${Math.round(r.st.ram)}% · Disk ${Math.round(r.st.disk)}%` : r.st ? "Offline" : "Checking"}${r.lock ? " · locked" : ""}`,
    onClick: () => openVm(r.m.name),
  }));
  const big = (label, value, color) => v_flex().flex_none().w(96).gap(T.sp.xxs)
    .child(div().text_size(T.text.xs).text_color(t.dim).child(label))
    .child(div().text_size(T.text.xl).font_semibold().text_color(color ?? t.foreground).child(value));
  const heat = v_flex().w_full().p(T.pad.cardRoomy).gap(T.sp.lg).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border)
    .child(h_flex().gap(T.sp.lg).items_center()
      .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child("Load"))
      .child(div().flex_1())
      .child(legend(t, [["< 20%", loadColor(10, t)], ["45%", loadColor(50, t)], ["70%", loadColor(75, t)], ["85%+", loadColor(90, t)], ["Offline", `${BAD}33`]])))
    .child(h_flex().w_full().gap(T.sp.xxl).items_start()
      .child(div().flex_1().min_w(0).child(heatGrid(t, "mp-mo-heat", cells, { size: rows.length > 120 ? 10 : 14, gap: 3 })))
      .when(cw >= 760, (e) => e.child(h_flex().flex_none().gap(T.sp.lg)
        .child(big("Avg CPU", avg("cpu") == null ? "–" : `${avg("cpu")}%`))
        .child(big("Avg RAM", avg("ram") == null ? "–" : `${avg("ram")}%`))
        .child(big("Disks ≥ 85%", String(fullDisks), fullDisks ? WARN : null))
        .child(big("Offline", String(offline), offline ? BAD : null)))));

  // Toolbar: search, status filter (counts), grouping.
  const seg = (id, items, cur, pick) => h_flex().flex_none().p(T.sp.xxs).gap(T.sp.xxs).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
    .children(items.map(([k, label, n]) => h_flex().id(`${id}-${k}`).h(22).px(T.sp.md).gap(T.sp.sm).rounded(T.r.chip).items_center().cursor_pointer()
      .bg(cur === k ? t.surface : clear).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { pick(k); MS.limit = PAGE; cx.notify(); })
      .child(div().text_size(T.text.sm).font_medium().text_color(cur === k ? t.foreground : t.muted).child(label))
      .when(n != null, (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(String(n))))));
  const toolbar = h_flex().w_full().gap(T.sp.md).items_center().flex_wrap()
    .child(h_flex().id("mp-mo-q").flex_none().w(260).h(T.h.btnSm + 2).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).bg(t.raised).border_1().border_color(q ? t.accent : t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(iconEl("search", t.dim, 12))
      .child(MS.input ? Input.new(MS.input).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground) : div().flex_1()))
    .child(seg("mp-mo-st", STATUS.map(([k, l]) => [k, l, counts[k]]), MS.status, (k) => { MS.status = k; }))
    .child(div().flex_1())
    .child(div().text_size(T.text.xs).text_color(t.dim).child("Group"))
    .child(seg("mp-mo-g", [["none", "None"], ["project", "Project"], ["prefix", "Prefix"]], MS.group, (k) => { MS.group = k; MS.closed = {}; }));

  // Table
  const COLS = [["name", "Machine", "grow"], ["status", "Status", 84], ["cpu", "CPU", 120], ...(showRam ? [["ram", "RAM", 120]] : []), ...(showDisk ? [["disk", "Disk", 120]] : []),
    ...(showProj ? [[null, "Projects", 170]] : []), [null, "", 20]];
  const head = h_flex().h(T.h.rowDense).px(T.sp.md).gap(T.sp.lg).items_center().border_b_1().border_color(t.border)
    .children(COLS.map(([k, label, w], i) => {
      let el = h_flex().id(`mp-mo-h-${i}`).min_w(0).gap(T.sp.xs).items_center().text_size(T.text.xs).text_color(MS.sort === k ? t.foreground : t.dim);
      el = w === "grow" ? el.flex_1() : el.flex_none().w(w);
      if (k) el = el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { if (MS.sort === k) MS.dir = -MS.dir; else { MS.sort = k; MS.dir = k === "name" ? 1 : -1; } cx.notify(); });
      return el.child(label).when(MS.sort === k, (e) => e.child(MS.dir > 0 ? "↑" : "↓"));
    }));
  const rowEl = (r) => {
    const [hl, hc] = r.health;
    const el = h_flex().id(`mp-mo-r-${r.m.name}`).h(T.h.row).px(T.sp.md).gap(T.sp.lg).items_center().rounded(T.r.ctrl).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => openVm(r.m.name))
      .child(h_flex().flex_1().min_w(0).gap(T.sp.md).items_center()
        .child(div().flex_none().size(T.dot).rounded_full().bg(hc))
        .child(div().flex_none().max_w("60%").truncate().text_size(T.text.sm).font_medium().child(r.m.name))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(r.m.host ?? "")))
      .child(div().flex_none().w(84).truncate().text_size(T.text.xs).text_color(hl === "Online" ? t.muted : hc).child(hl))
      .child(usage(t, r.st?.ok ? r.st.cpu : NaN, 120))
      .when(showRam, (e) => e.child(usage(t, r.st?.ok ? r.st.ram : NaN, 120)))
      .when(showDisk, (e) => e.child(usage(t, r.st?.ok ? r.st.disk : NaN, 120)))
      .when(showProj, (e) => e.child(h_flex().flex_none().w(170).min_w(0).gap(T.sp.sm).items_center().overflow_hidden()
        .children(r.projects.slice(0, 1).map((p) => h_flex().min_w(0).gap(T.sp.sm).items_center().child(tile(p.name, { kind: "project", size: 14, color: p.color }))
          .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(p.name))))
        .when(r.projects.length > 1, (x) => x.child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`+${r.projects.length - 1}`)))
        .when(!r.projects.length, (x) => x.child(div().text_size(T.text.xs).text_color(t.dim).child("—")))))
      .child(h_flex().id(`mp-mo-l-${r.m.name}`).flex_none().w(20).justify_end().when(Boolean(r.lock), (e) => e.tooltip(lockTip(r.lock)).child(iconEl("lock", WARN, 12))));
    return ws.navMark ? ws.navMark(el, { key: `vm:${r.m.name}`, open: () => openVm(r.m.name), ref: { kind: "vm", name: r.m.name } }) : el;
  };
  const body = v_flex().w_full();
  let left = MS.limit, total = shown.length;
  for (const [g, rs] of G) {
    if (left <= 0) break;
    const closed = MS.group !== "none" && MS.closed[g];
    if (MS.group !== "none") {
      const okG = rs.filter((r) => r.st?.ok);
      const avgG = okG.length ? Math.round(okG.reduce((s, r) => s + r.st.cpu, 0) / okG.length) : null;
      const offG = rs.length - okG.length;
      body.child(h_flex().id(`mp-mo-g-${g}`).h(T.h.rowDense).mt(T.sp.md).px(T.sp.md).gap(T.sp.md).items_center().cursor_pointer().rounded(T.r.ctrl).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { MS.closed[g] = !closed; cx.notify(); })
        .child(iconEl(closed ? "chevron-right" : "chevron-down", t.dim, 12))
        .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(g))
        .child(div().text_size(T.text.xs).text_color(t.dim).child(`${rs.length}${avgG != null ? ` · avg CPU ${avgG}%` : ""}${offG ? ` · ${offG} offline` : ""}`))
        .child(div().flex_1())
        .child(h_flex().flex_none().gap(2).children(rs.slice(0, 40).map((r) => div().size(6).rounded(1).bg(r.st?.ok ? loadColor(r.st.cpu, t) : `${BAD}88`)))));
    }
    if (closed) { total -= rs.length; continue; }
    for (const r of rs.slice(0, left)) body.child(rowEl(r));
    left -= rs.length;
  }
  const hidden = Math.max(0, total - MS.limit);
  const more = (id, label, fn) => h_flex().id(id).h(T.h.btnSm).px(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { fn(); cx.notify(); }).child(div().text_size(T.text.sm).text_color(t.accent).child(label));
  const foot = h_flex().h(T.h.row).px(T.sp.sm).gap(T.sp.md).items_center()
    .child(div().text_size(T.text.xs).text_color(t.dim).child(`Showing ${Math.min(total, MS.limit)} of ${shown.length}${shown.length !== rows.length ? ` (filtered from ${rows.length})` : ""}`))
    .when(hidden > 0, (e) => e.child(more("mp-mo-more", `Show ${Math.min(PAGE, hidden)} more`, () => { MS.limit += PAGE; }))
      .child(more("mp-mo-all", `Show all ${total}`, () => { MS.limit = Infinity; })))
    .when(MS.limit > PAGE && hidden === 0 && total > PAGE, (e) => e.child(more("mp-mo-less", "Show less", () => { MS.limit = PAGE; })));
  const table = v_flex().w_full().px(T.sp.xs).pb(T.sp.xs).rounded(T.r.panel).bg(t.surface).border_1().border_color(t.border)
    .child(head)
    .when(!shown.length, (e) => e.child(emptyLine(t, "mp-mo-none", rows.length ? "No machine matches." : "No machines yet.", rows.length ? ["Clear filters", () => { MS.q = ""; MS.status = "all"; MS.input?.set_value(""); }] : ["Add machine", () => openForm("vm-add", {})])))
    .child(body)
    .when(shown.length > 0, (e) => e.child(foot.border_t_1().border_color(t.border).mt(T.sp.xs)));
  return v_flex().w_full().gap(T.sp.xl).child(header).child(heat).child(toolbar).child(table);
}
