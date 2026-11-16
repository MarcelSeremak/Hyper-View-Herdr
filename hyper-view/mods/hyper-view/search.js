// Global search: projects, machines, tasks, agent messages, clipboard notes and secrets.
// The index is built from the same files the app shows and cached for a few seconds.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { setShared, run } from "herdr";
import {
  listProjects, loadProject, loadEvents, loadMachines, loadSecrets, selectProject, openVm, openSecrets, openClipboard, showCenter,
  tile, iconEl, TASK_EN, TASK_COLOR, fmtTime, clear, colorFor, scrollY,
} from "./lib.js";
import { loadClips } from "./clipboard.js";
import { openTaskPanel } from "./taskpanel.js";

const TTL = 15000;
let cache = null;

export async function buildIndex() {
  if (cache && Date.now() - cache.at < TTL) return cache.items;
  const items = [];
  const projects = await listProjects();
  for (const p of projects) {
    items.push({ kind: "project", title: p.name, sub: p.desc || `${p.machines.length} machines · ${p.agents.length} agents`, hay: `${p.name} ${p.desc ?? ""}`, p });
    const full = await loadProject(p.slug);
    for (const x of full?.tasks ?? []) items.push({ kind: "task", title: `#${x.id} ${x.title}`, sub: `${p.name} · ${x.agent ?? "unassigned"} · ${TASK_EN[x.status] ?? x.status}`, hay: `${x.title} ${x.desc ?? ""} ${x.agent ?? ""}`, p, x });
    for (const a of full?.agents ?? []) items.push({ kind: "agent", title: a.name, sub: `${p.name} · ${a.role || a.app}`, hay: `${a.name} ${a.role ?? ""}`, p, a });
    const events = await loadEvents(p.slug);
    for (const e of events.slice(-400)) {
      if (e.type !== "message") continue;
      items.push({ kind: "message", title: e.text, sub: `${p.name} · ${e.from === "ty" ? "You" : e.from} · ${fmtTime(e.ts)}`, hay: `${e.text} ${e.from}`, p, e });
    }
  }
  for (const m of await loadMachines()) items.push({ kind: "vm", title: m.name, sub: `${m.os || ""} ${m.user}@${m.host}`.trim(), hay: `${m.name} ${m.host} ${m.os ?? ""} ${m.desc ?? ""}`, m });
  for (const c of (await loadClips()).items) items.push({ kind: "note", title: c.title || "Untitled", sub: `${c.kind ?? "note"} · ${String(c.text).slice(0, 60)}`, hay: `${c.title} ${c.text}`, c });
  for (const s of await loadSecrets()) items.push({ kind: "secret", title: s.name, sub: s.kind, hay: `${s.name} ${s.kind} ${s.desc ?? ""}`, s });
  cache = { at: Date.now(), items };
  return items;
}

export function search(items, q, limit = 4) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = {};
  for (const it of items) {
    const hay = it.hay.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    (groups[it.kind] ??= []).push(it);
  }
  return ORDER.filter((k) => groups[k]).map((k) => ({ kind: k, total: groups[k].length, items: groups[k].slice(0, limit) }));
}

const ORDER = ["project", "task", "agent", "message", "vm", "note", "secret"];
const LABEL = { project: "Projects", task: "Tasks", agent: "Agents", message: "Messages", vm: "Machines", note: "Clipboard", secret: "Secrets" };

function open(it) {
  if (it.kind === "project") { selectProject(it.p.slug, "overview"); showCenter("mp-view"); }
  else if (it.kind === "task") { selectProject(it.p.slug, "tasks"); openTaskPanel(it.p.slug, it.x.id); showCenter("mp-view"); }
  else if (it.kind === "agent") { selectProject(it.p.slug, "agents"); setShared("mp.openAgent", { slug: it.p.slug, name: it.a.name, at: Date.now() }); showCenter("mp-view"); }
  else if (it.kind === "message") { selectProject(it.p.slug, "activity"); showCenter("mp-view"); }
  else if (it.kind === "vm") { openVm(it.m.name); showCenter("mp-view"); }
  else if (it.kind === "note") { openClipboard(); showCenter("mp-view"); }
  else if (it.kind === "secret") { openSecrets(); showCenter("mp-view"); }
}

// Leading glyph: entity tiles for projects / machines / agents; plain muted icons for the rest (no decorative fills).
function glyph(it, t) {
  const ic = (name) => h_flex().size(20).flex_none().items_center().justify_center().child(iconEl(name, t.dim, 14));
  switch (it.kind) {
    case "project": return tile(it.p.name, { kind: "project", size: 20, color: it.p.color });
    case "vm": return tile(it.m.name, { kind: "vm", size: 20 });
    case "task": return h_flex().size(20).flex_none().items_center().justify_center().child(div().size(T.dot).rounded_full().bg(TASK_COLOR[it.x.status] ?? t.dim));
    case "agent": return tile(it.a.name, { size: 20, glyph: "bot", color: colorFor(`agent:${it.a.name}`), radius: 10 });
    case "message": return ic("messages");
    case "note": return ic("paperclip");
    default: return ic("key");
  }
}

export function resultsPanel(t, groups, q, onPick) {
  if (!groups) return v_flex().px(12).py(12).child(div().text_size(T.text.xs).text_color(t.dim).child("Searching…"));
  if (!groups.length) return v_flex().px(12).py(12).child(div().text_size(T.text.sm).text_color(t.dim).child(`No results for “${q}”`));
  return scrollY("mp-search-results", v_flex().pb(8).children(groups.map((g) =>
    v_flex().pb(6)
      .child(h_flex().h(26).px(12).items_center()
        .child(div().flex_1().text_size(T.text.xs).font_medium().text_color(t.dim).child(LABEL[g.kind]))
        .when(g.total > g.items.length, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(`${g.total}`))))
      .children(g.items.map((it, i) => h_flex().id(`mp-sr-${g.kind}-${i}`).mx(8).h(36).px(8).gap(8).items_center().rounded(T.r.panel).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open(it); onPick(cx); })
        .child(glyph(it, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(T.text.sm).truncate().text_color(t.foreground).child(it.title))
          .child(div().text_size(T.text.xs).truncate().text_color(t.dim).child(it.sub))))))));
}
