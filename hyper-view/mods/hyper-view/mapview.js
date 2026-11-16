// Agent map (full-width view, shared("mp.view") = { kind: "map" }): every agent of every project as a little
// ghost on a pixel-art village. Where a ghost walks says what it is doing (semantic zones):
//   Manor = working · Pond dock = waiting for you · Ruins = blocked · Crossroads = in review · Graveyard = idle / stopped.
// Movement is native GPUI motion (transition on left/top, 2-4 s ease-in-out): one 1 s timer picks the next
// targets for a few ghosts, nothing runs per frame. Click a ghost: it stops and a card shows its task, a mini
// kanban and actions (Chat, Assign task, Open, Start/Stop). Drag a ghost: Graveyard = stop, Manor = start /
// resume, onto another ghost = hand over the current task (always confirmed; demo mode only toasts).
// Keys (workspace.js onKey → mapKey): Tab / arrows cycle ghosts, Enter opens the card, Esc closes, c chat, t task, o open.
import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, setShared, run } from "herdr";
import { T } from "./tokens.js";
import { kbd } from "./ide.js";
import {
  demo, listProjects, loadProject, liveAgent, currentTask, nextTask, isWaiting, startAgent, hp, toast, view, claimJob, arr,
  colorFor, iconEl, button, iconButton, meter, clear, MOD, OK, WARN, BAD, INFO, TASK_COLOR, TASK_EN,
} from "./lib.js";
import { openForm } from "./form.js";
import { openTaskPanel } from "./taskpanel.js";
import { openAgentPage } from "./toolbar.js";
import { markManualStop, resetRestarts } from "./supervisor.js";

const MAP = `mods/${MOD}/icons/agent-map.jpg`;
const IW = 1672, IH = 941;
const MAX = 60; // ghosts drawn; the rest are counted ("+N")
const IDLE_C = "#9aa3ad";
// Zones in image coordinates (0-1): where ghosts of a state wander (rect) and where its sign stands.
export const ZONES = {
  working: { place: "Manor", meaning: "Working", color: OK, rect: [0.63, 0.43, 0.87, 0.53], sign: [0.765, 0.075] },
  waiting: { place: "Pond dock", meaning: "Waiting for you", color: WARN, rect: [0.235, 0.70, 0.35, 0.79], sign: [0.17, 0.655] },
  blocked: { place: "Ruins", meaning: "Blocked", color: BAD, rect: [0.60, 0.72, 0.77, 0.86], sign: [0.685, 0.645] },
  review: { place: "Crossroads", meaning: "In review", color: INFO, rect: [0.43, 0.56, 0.54, 0.66], sign: [0.485, 0.525] },
  idle: { place: "Graveyard", meaning: "Idle · stopped", color: IDLE_C, rect: [0.19, 0.30, 0.48, 0.44], sign: [0.33, 0.535] },
};
const ZONE_ORDER = ["waiting", "blocked", "working", "review", "idle"];
const STATE_EN = { working: "Working", waiting: "Waiting for you", blocked: "Blocked", review: "In review", idle: "Idle", stopped: "Stopped" };
const STATE_C = { working: OK, waiting: WARN, blocked: BAD, review: INFO, idle: IDLE_C, stopped: "#6b6b80" };
const RANK = { waiting: 0, blocked: 1, working: 2, review: 3, idle: 4, stopped: 5 };
// Project filter (chips): a slug, "__loose" (every loose agent) or null.
const inFilter = (f) => !S.filter || (S.filter === "__loose" ? Boolean(f.p.loose) : f.p.slug === S.filter);
const zoneOf = (state) => (state === "stopped" ? "idle" : state);
// Everything that drives the whole map on view coords: the visible part of the image is centred on this point.
const FOCUS = [0.52, 0.47];
const BBOX = [0.80, 0.84]; // zones + signs; the fit scale keeps them on screen (letterbox instead of cropping them away)

const S = (globalThis.__hvMap ??= {
  at: 0, loading: 0, projects: [], pos: {}, sel: null, kb: null, drag: null, panStart: null, pan: { x: 0, y: 0 }, zoom: 1,
  filter: null, W: 0, H: 0, confirm: null, legend: true, lastTick: 0, snapUntil: 0, cardH: 300, keys: [], facts: [],
});

// ------------------------------------------------------------ data
async function load() {
  const out = [];
  for (const p0 of await listProjects()) {
    if (!arr(p0.agents).length) continue;
    const full = await loadProject(p0.slug).catch(() => null);
    out.push({ ...(full ?? {}), ...p0, agents: arr(p0.agents), tasks: arr(full?.tasks) });
  }
  return out;
}
function refresh(cx) {
  S.loading = Date.now();
  cx.spawn(async (cx) => {
    try { S.projects = await load(); } catch {}
    S.at = Date.now(); S.loading = 0;
    cx.notify();
  });
}

// One agent's place on the map.
function factsOf(p, a) {
  const live = liveAgent(p, a.name);
  const cur = currentTask(p, a.name);
  const mine = p.tasks.filter((x) => x.agent === a.name);
  const state = live && (live.status === "blocked" || isWaiting(a.name, live)) ? "waiting"
    : cur?.status === "blocked" ? "blocked"
    : live?.status === "working" ? "working"
    : mine.some((x) => x.status === "review") ? "review"
    : live ? "idle" : "stopped";
  return { key: `${p.slug}/${a.name}`, p, a, live, cur, mine, state, zone: zoneOf(state) };
}

// ------------------------------------------------------------ motion
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function placeIn(zone, from, self) {
  const [x0, y0, x1, y1] = ZONES[zone].rect;
  // A short stroll from where it stands (stays inside its zone); a few tries to keep off the others' toes.
  const pick = () => (from ? [clamp(from[0] + rnd(-0.07, 0.07), x0, x1), clamp(from[1] + rnd(-0.05, 0.05), y0, y1)] : [rnd(x0, x1), rnd(y0, y1)]);
  let best = pick(), bestD = -1;
  for (let i = 0; i < 6; i++) {
    const c = i ? pick() : best;
    let d = Infinity;
    for (const [k, p] of Object.entries(S.pos)) if (k !== self && p.zone === zone) d = Math.min(d, Math.hypot(p.u - c[0], (p.v - c[1]) * 1.8));
    if (d > 0.05) return c;
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}
function posOf(f) {
  let p = S.pos[f.key];
  if (!p) {
    const [u, v] = placeIn(f.zone, null, f.key);
    p = S.pos[f.key] = { u, v, zone: f.zone, dur: 0, next: Date.now() + rnd(500, 4000) };
  } else if (p.zone !== f.zone) {
    // State changed: it walks over to its new place (a longer walk across the village).
    const [u, v] = placeIn(f.zone, null, f.key);
    Object.assign(p, { u, v, zone: f.zone, dur: Math.round(rnd(3800, 5200)), next: Date.now() + 6500 });
  }
  return p;
}
function stroll(f, now) {
  const p = S.pos[f.key];
  if (!p) return false;
  const sleepy = f.state === "stopped";
  const [u, v] = placeIn(p.zone, [p.u, p.v], f.key);
  const dur = Math.round(sleepy ? rnd(4000, 6000) : rnd(2000, 4000));
  Object.assign(p, { u, v, dur, next: now + dur + (sleepy ? rnd(5000, 10000) : rnd(1000, 3000)) });
  return true;
}
// One timer per view (1 s): data refresh + the next stroll of a few ghosts. Stops itself off the map.
function ensureTick(cx) {
  if (Date.now() - S.lastTick < 3000) return;
  S.lastTick = Date.now();
  const mine = claimJob("map.tick");
  let task = null;
  task = cx.timer.every(1000, (cx) => {
    if (!mine() || view().kind !== "map") { if (mine()) S.lastTick = 0; try { task?.cancel(); } catch {} return; }
    S.lastTick = Date.now();
    if (Date.now() - S.at > 6000 && (!S.loading || Date.now() - S.loading > 60000)) refresh(cx);
    if (S.drag?.moved || S.panStart) return;
    const now = Date.now();
    let n = 0;
    for (const f of S.facts) {
      if (n >= 8) break;
      if (f.key === S.sel) continue;
      const p = S.pos[f.key];
      if (p && now >= p.next && stroll(f, now)) n++;
    }
    if (n) cx.notify();
  });
}

// ------------------------------------------------------------ geometry
function geo() {
  const W = Math.max(200, S.W || 1000), H = Math.max(200, S.H || 700);
  const cover = Math.max(W / IW, H / IH);
  const fit = Math.min(W / (IW * BBOX[0]), H / (IH * BBOX[1]));
  const s = Math.min(cover, fit) * S.zoom;
  const iw = IW * s, ih = IH * s;
  const axis = (V, size, c, pan) => (size <= V ? (V - size) / 2 : clamp(V / 2 - c * size + pan, V - size, 0));
  const ox = axis(W, iw, FOCUS[0], S.pan.x), oy = axis(H, ih, FOCUS[1], S.pan.y);
  // Pan is stored as what survived the clamp (no dead zone when dragging back).
  S.pan.x = iw <= W ? 0 : ox - (W / 2 - FOCUS[0] * iw);
  S.pan.y = ih <= H ? 0 : oy - (H / 2 - FOCUS[1] * ih);
  const g = Math.round(clamp((iw / IW) * 46, 26, 60));
  return { W, H, iw, ih, ox, oy, g, gh: Math.round(g * 1.225) };
}
const ghostImg = (name, sleepy) => `mods/${MOD}/icons/ghosts/${colorFor(`agent:${name}`).slice(1)}-${sleepy ? "sleep" : "awake"}.svg`;
const alpha = (c, a) => (typeof c === "string" && c.length === 7 ? `${c}${a}` : c);
function zoneAt(u, v) {
  for (const z of ZONE_ORDER) {
    const [x0, y0, x1, y1] = ZONES[z].rect;
    if (u >= x0 - 0.05 && u <= x1 + 0.05 && v >= y0 - 0.07 && v <= y1 + 0.03) return z;
  }
  return null;
}
function ghostAt(G, lx, ly, except) {
  let best = null, bd = G.g * 0.9;
  for (const f of S.facts) {
    if (f.key === except) continue;
    const p = S.pos[f.key];
    if (!p) continue;
    const x = G.ox + p.u * G.iw, y = G.oy + p.v * G.ih - G.gh / 2;
    const d = Math.hypot(x - lx, y - ly);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

// ------------------------------------------------------------ actions
const factByKey = (key) => S.facts.find((f) => f.key === key) ?? null;
function select(key, cx) {
  S.sel = key; S.kb = key ?? S.kb;
  cx?.notify?.();
}
export function chatWith(f, cx) {
  const go = () => setShared("mp.chatGo", { name: f.p.loose ? null : f.a.name, text: f.p.loose ? "" : `@${f.a.name} `, at: Date.now() });
  // The chat follows shared "mp.project" outside project pages; it reloads (and drops its filter) on a switch.
  if (shared("mp.project") !== f.p.slug) { setShared("mp.project", f.p.slug); cx.timer.after(900, () => go()); } else go();
}
const assign = (f) => openForm("task-add", { project: f.p.slug, for: f.a.name });
const openPage = (f) => openAgentPage(f.p.slug, f.a.name, f.p.loose ? "agents" : "projects");
function startStop(f, cx, what = f.live ? "stop" : "start") {
  if (demo()) { toast(`${what === "stop" ? "Stopped" : "Started"} ${f.a.name}`, "Demo mode: nothing was changed.", "success"); return; }
  if (what === "stop" && f.live) { markManualStop(f.p.slug, f.a.name); run("terminal.kill", { terminal: f.live.address }); toast(`Stopped ${f.a.name}`, "", "success"); }
  else if (what === "start" && !f.live) { resetRestarts(f.p.slug, f.a.name); startAgent(f.p, f.a); toast(`Starting ${f.a.name}`, "", "success"); }
  cx.timer.after(1500, (cx) => refresh(cx));
}
function ask(text, sub, label, go, danger = false) { S.confirm = { text, sub, label, go, danger }; }
async function hpDo(args, opts, ok) {
  if (demo()) { toast(ok, "Demo mode: nothing was changed.", "success"); return; }
  const r = await hp(args, opts);
  if (!r.ok) toast("Something went wrong", r.err, "error"); else toast(ok, "", "success");
}
// A ghost let go somewhere: what it means there.
function drop(G, f, d, cx) {
  const other = ghostAt(G, d.lx, d.ly, f.key);
  const zone = zoneAt(d.u, d.v);
  if (other) {
    if (other.p.slug !== f.p.slug) toast("Different projects", `${f.a.name} and ${other.a.name} are not in the same project.`, "info");
    else if (!f.cur) toast(`${f.a.name} has no current task`, "Nothing to hand over.", "info");
    else ask(`Hand #${f.cur.id} ${f.cur.title} to ${other.a.name}?`, `${f.a.name} → ${other.a.name} · with a handoff note, ack requested`, "Hand over", (cx) =>
      cx.spawn(async (cx) => { await hpDo(["task", "handoff", String(f.cur.id)], { p: f.p.slug, to: other.a.name, as: "ty", note: `Handed over from ${f.a.name} by the human (Agent map).` }, `#${f.cur.id} handed to ${other.a.name}`); refresh(cx); }));
  } else if (zone === "idle") {
    if (!f.live) toast(`${f.a.name} is already asleep`, "Stopped agents rest in the graveyard.", "info");
    else ask(`Stop ${f.a.name}?`, f.cur ? `It is on #${f.cur.id} ${f.cur.title}; the task stays assigned.` : "Its terminal is closed.", "Stop", (cx) => startStop(f, cx, "stop"), true);
  } else if (zone === "working") {
    if (!f.live) ask(`Start ${f.a.name}?`, nextTask(f.p, f.a.name) ? `Next up: #${nextTask(f.p, f.a.name).id} ${nextTask(f.p, f.a.name).title}` : "It reads its tasks and inbox first.", "Start", (cx) => startStop(f, cx, "start"));
    else if (f.state === "working") toast(`${f.a.name} is already working`, "", "info");
    else ask(`Ask ${f.a.name} to resume its tasks?`, "Sends it a message in the project chat.", "Send", (cx) =>
      cx.spawn(async () => hpDo(["say", `Please resume your tasks (hp task list --as ${f.a.name}).`], { p: f.p.slug, as: "ty", to: f.a.name }, `Asked ${f.a.name} to resume`)));
  } else toast("Nothing happens there", "Drop on the Manor to start, the Graveyard to stop, or on another ghost to hand over the task.", "info");
  // Back to its own place, walking.
  const p = S.pos[f.key];
  if (p) { const [nu, nv] = placeIn(p.zone, null, f.key); Object.assign(p, { u: nu, v: nv, dur: 1800, next: Date.now() + 4000 }); }
  cx.notify();
}

// ------------------------------------------------------------ keys (workspace.js onKey)
export function mapKey(e, cx) {
  const k = e.key, m = e.modifiers ?? {};
  if (k === "escape") {
    if (S.confirm) { S.confirm = null; return true; }
    if (S.sel) { S.sel = null; return true; }
    return false;
  }
  if (S.confirm && k === "enter") { const c = S.confirm; S.confirm = null; c.go(cx); return true; }
  const list = S.facts.filter(inFilter).map((f) => f.key);
  if (!list.length) return false;
  const i = list.indexOf(S.sel ?? S.kb);
  const step = (d) => {
    const j = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    S.kb = list[j]; if (S.sel) S.sel = list[j];
    return true;
  };
  if (k === "tab") return step(m.shift ? -1 : 1);
  if (k === "right" || k === "down" || k === "j" || k === "l") return step(1);
  if (k === "left" || k === "up" || k === "k" || k === "h") return step(-1);
  if (k === "enter") { if (S.sel) { const f = factByKey(S.sel); if (f) openPage(f); } else S.sel = S.kb ?? list[0]; return true; }
  const f = S.sel ? factByKey(S.sel) : null;
  if (!f) return false;
  if (k === "c") { chatWith(f, cx); return true; }
  if (k === "t") { assign(f); return true; }
  if (k === "o") { openPage(f); return true; }
  return false;
}

// ------------------------------------------------------------ pieces
const stopDown = (_e, cx) => cx.stop_propagation();
function panel(t) {
  return h_flex().rounded(T.r.panel).bg(alpha(t.surface, "eb")).border_1().border_color(t.border).shadow_md();
}
function ghostEl(t, G, f, now, dropOn) {
  const p = S.pos[f.key];
  const dragging = S.drag?.moved && S.drag.key === f.key;
  const u = dragging ? S.drag.u : p.u, v = dragging ? S.drag.v : p.v;
  const sel = S.sel === f.key, kb = !S.sel && S.kb === f.key;
  const dim = !inFilter(f);
  const sleepy = f.state === "stopped";
  const c = STATE_C[f.state];
  const { g, gh } = G;
  const dur = now < S.snapUntil ? 140 : p.dur || 0;
  const bob = 1800 + (f.key.length * 137) % 900;
  const tip = `${f.a.name} · ${f.p.loose ? "loose agent" : f.p.name} · ${STATE_EN[f.state]}${f.cur ? ` · #${f.cur.id} ${f.cur.title}` : ""}`;
  const ring = div().absolute().left(-Math.round(g * 0.12)).top(gh - Math.round(g * 0.2)).w(Math.round(g * 1.24)).h(Math.round(g * 0.34)).rounded_full();
  let shadow;
  if (f.state === "working") shadow = ring.bg(alpha(OK, "88")).border_1().border_color(OK).loop("opacity", { from: 0.35, to: 1, period: 1400 });
  else if (f.state === "waiting") shadow = ring.bg(alpha(WARN, "33")).border_2().border_color(WARN);
  else if (f.state === "blocked") shadow = ring.bg(alpha(BAD, "55")).border_2().border_color(BAD);
  else if (f.state === "review") shadow = ring.bg(alpha(INFO, "44")).border_1().border_color(INFO);
  else shadow = ring.bg("#00000055");
  const bubble = (txt, bg, fg = "#ffffff") => h_flex().absolute().top(-Math.round(g * 0.32)).left(Math.round(g * 0.72)).size(Math.round(clamp(g * 0.42, 14, 22))).rounded_full()
    .items_center().justify_center().bg(bg).border_1().border_color("#1b2824").text_size(T.text.xs).font_semibold().text_color(fg).child(txt);
  const labelW = 140;
  let el = div().id(`mp-map-g-${f.key}`).absolute().left(Math.round(G.ox + u * G.iw - g / 2)).top(Math.round(G.oy + v * G.ih - gh)).w(g).h(gh)
    .cursor_pointer().tooltip(tip)
    .when(!dragging && dur > 0, (e) => e.transition("left", { duration: dur, easing: "ease-in-out" }).transition("top", { duration: dur, easing: "ease-in-out" }))
    .when(Boolean(dim), (e) => e.opacity(0.28))
    .on_mouse_down("left", (ev, _cx) => { S.drag = { key: f.key, x: ev.position.x, y: ev.position.y, t: Date.now(), moved: false }; })
    .on_click((_e, cx) => { if (S.drag?.moved) return; S.drag = null; select(S.sel === f.key ? null : f.key, cx); })
    .child(shadow)
    .when(sel || kb || dropOn, (e) => e.child(div().absolute().left(-Math.round(g * 0.2)).top(gh - Math.round(g * 0.26)).w(Math.round(g * 1.4)).h(Math.round(g * 0.46)).rounded_full()
      .border_2().border_color(dropOn ? "#ffffff" : t.accent)))
    .child(div().absolute().left(0).top(0).w(g).h(gh)
      .when(!sleepy && !dragging, (e) => e.loop("top", { from: 0, to: -Math.max(3, Math.round(g * 0.1)), period: bob }))
      .when(sleepy, (e) => e.opacity(0.6))
      .child(image(ghostImg(f.a.name, sleepy)).w(g).h(gh)))
    .when(f.state === "waiting", (e) => e.child(bubble("!", WARN).loop("top", { from: -Math.round(g * 0.32), to: -Math.round(g * 0.46), period: 900 })))
    .when(f.state === "blocked", (e) => e.child(bubble("!", BAD)))
    .when(sleepy, (e) => e.child(div().absolute().top(-Math.round(g * 0.3)).left(Math.round(g * 0.7)).text_size(T.text.sm).font_semibold().text_color("#e8efe9")
      .loop("opacity", { from: 0.2, to: 1, period: 2400 }).child("z z")))
    .child(h_flex().absolute().top(gh + 2).left(Math.round((g - labelW) / 2)).w(labelW).justify_center()
      .child(h_flex().max_w(labelW).h(16).px(T.sp.sm).gap(T.sp.xs).items_center().rounded(T.r.chip).bg(sel ? t.accent : "#0d1410cc")
        .child(div().flex_none().size(T.dot).rounded_full().bg(c))
        .child(div().min_w(0).truncate().text_size(T.text.xs).font_medium().text_color(sel ? t.accent_foreground : "#eef3ee").child(f.a.name))));
  return el;
}
function signs(t, G, counts, dropZone) {
  return Object.entries(ZONES).map(([z, Z]) => {
    const n = counts[z] ?? 0;
    const hot = dropZone === z;
    const x = Math.round(G.ox + Z.sign[0] * G.iw), y = Math.round(G.oy + Z.sign[1] * G.ih);
    return h_flex().id(`mp-map-sign-${z}`).absolute().left(x - 90).top(y - 11).w(180).justify_center()
      .child(h_flex().h(22).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).bg(hot ? alpha(Z.color, "ee") : "#0d1410d0")
        .border_1().border_color(hot ? "#ffffff" : alpha(Z.color, "aa"))
        .tooltip(`${Z.place}: ${Z.meaning.toLowerCase()}${z === "working" ? "\nDrop a ghost here to start it" : z === "idle" ? "\nDrop a ghost here to stop it" : ""}`)
        .child(div().flex_none().size(T.dot).rounded_full().bg(hot ? "#ffffff" : Z.color))
        .child(div().text_size(T.text.xs).font_medium().text_color("#eef3ee").child(Z.place))
        .when(n > 0, (e) => e.child(div().text_size(T.text.xs).text_color(hot ? "#ffffff" : "#b9c4bb").child(String(n)))));
  });
}
function chips(t, all) {
  const projs = [];
  for (const f of all) if (!projs.some((p) => p.slug === f.p.slug)) projs.push(f.p);
  const chip = (id, label, color, n, on, go) => h_flex().id(id).flex_none().h(T.h.btnSm - 2).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
    .bg(on ? t.selected : clear).hover((s) => s.bg(t.hover)).on_mouse_down("left", stopDown).on_click((_e, cx) => { go(); cx.notify(); })
    .when(Boolean(color), (e) => e.child(div().flex_none().size(T.dot).rounded(2).bg(color)))
    .child(div().max_w(140).truncate().text_size(T.text.xs).font_medium().text_color(on ? t.foreground : t.muted).child(label))
    .child(div().text_size(T.text.xs).text_color(t.dim).child(String(n)));
  const named = projs.filter((p) => !p.loose), loose = projs.filter((p) => p.loose);
  const items = [chip("mp-map-f-all", "All", null, all.length, !S.filter, () => { S.filter = null; })]
    .concat(named.map((p) => chip(`mp-map-f-${p.slug}`, p.name, p.color ?? colorFor(`project:${p.name}`), all.filter((f) => f.p.slug === p.slug).length, S.filter === p.slug, () => { S.filter = S.filter === p.slug ? null : p.slug; })));
  if (loose.length) items.push(chip("mp-map-f-loose", "Loose", "#5f7f76", all.filter((f) => f.p.loose).length, S.filter === "__loose", () => { S.filter = S.filter === "__loose" ? null : "__loose"; }));
  return panel(t).id("mp-map-chips").absolute().top(T.sp.lg).left(T.sp.lg).max_w(Math.max(240, (S.W || 900) - 420)).p(T.sp.xs).gap(T.sp.xxs).flex_wrap()
    .on_mouse_down("left", stopDown).children(items);
}
function countsBar(t, by, extra) {
  const part = (k, label) => (by[k] ? h_flex().gap(T.sp.xs).items_center().child(div().size(T.dot).rounded_full().bg(STATE_C[k]))
    .child(div().text_size(T.text.xs).text_color(t.foreground).child(String(by[k]))).child(div().text_size(T.text.xs).text_color(t.muted).child(label)) : null);
  const parts = [part("working", "working"), part("waiting", "waiting"), part("blocked", "blocked"), part("review", "review"), part("idle", "idle"), part("stopped", "asleep")].filter(Boolean);
  const zoomBtn = (id, ic, tip, fn) => iconButton(t, id, ic, (_e, cx) => { fn(); S.snapUntil = Date.now() + 400; cx.notify(); }, tip, { size: 22 });
  return panel(t).id("mp-map-counts").absolute().top(T.sp.lg).right(T.sp.lg).h(T.h.btn + 2).pl(T.sp.md).pr(T.sp.xs).gap(T.sp.md).items_center()
    .on_mouse_down("left", stopDown)
    .children(parts.length ? parts : [div().text_size(T.text.xs).text_color(t.dim).child("No agents")])
    .when(extra > 0, (e) => e.child(div().id("mp-map-more").text_size(T.text.xs).text_color(t.dim).tooltip(`${extra} more agents are not drawn (the map shows ${MAX})`).child(`+${extra}`)))
    .child(div().w(1).h(14).bg(t.border))
    .child(zoomBtn("mp-map-zout", "minus", "Zoom out  (wheel)", () => { S.zoom = clamp(S.zoom / 1.25, 1, 2.6); }))
    .child(div().id("mp-map-zreset").w(36).text_center().text_size(T.text.xs).text_color(t.muted).cursor_pointer().tooltip("Reset zoom")
      .on_click((_e, cx) => { S.zoom = 1; S.pan = { x: 0, y: 0 }; S.snapUntil = Date.now() + 400; cx.notify(); }).child(`${Math.round(S.zoom * 100)}%`))
    .child(zoomBtn("mp-map-zin", "plus", "Zoom in  (wheel)", () => { S.zoom = clamp(S.zoom * 1.25, 1, 2.6); }));
}
function legend(t) {
  if (!S.legend) {
    return panel(t).id("mp-map-legend-open").absolute().bottom(T.sp.lg).right(T.sp.lg).h(T.h.btnSm).px(T.sp.md).gap(T.sp.sm).items_center().cursor_pointer()
      .on_mouse_down("left", stopDown).on_click((_e, cx) => { S.legend = true; cx.notify(); })
      .child(iconEl("map", t.muted, 12)).child(div().text_size(T.text.xs).text_color(t.muted).child("Legend"));
  }
  const row = (z) => h_flex().h(18).gap(T.sp.sm).items_center()
    .child(div().flex_none().size(T.dot).rounded_full().bg(ZONES[z].color))
    .child(div().w(76).flex_none().text_size(T.text.xs).font_medium().text_color(t.foreground).child(ZONES[z].place))
    .child(div().text_size(T.text.xs).text_color(t.muted).child(ZONES[z].meaning));
  return v_flex().id("mp-map-legend").absolute().bottom(T.sp.lg).right(T.sp.lg).w(280).p(T.sp.md).gap(T.sp.xxs).rounded(T.r.panel)
    .bg(alpha(t.surface, "eb")).border_1().border_color(t.border).shadow_md().on_mouse_down("left", stopDown)
    .child(h_flex().items_center().pb(T.sp.xs)
      .child(div().flex_1().text_size(T.text.xs).font_medium().text_color(t.muted).child("Where ghosts go"))
      .child(iconButton(t, "mp-map-legend-x", "x", (_e, cx) => { S.legend = false; cx.notify(); }, "Hide legend", { size: 18 })))
    .children(ZONE_ORDER.map(row))
    .child(div().h(1).my(T.sp.xs).bg(t.border))
    .child(div().text_size(T.text.xs).text_color(t.dim).whitespace_normal()
      .child("Drag a ghost: Manor starts it, Graveyard stops it, onto another ghost hands over its task."))
    .child(h_flex().pt(T.sp.xs).gap(T.sp.sm).items_center().flex_wrap().text_size(T.text.xs).text_color(t.dim)
      .child(kbd(t, "Tab")).child("cycle").child(kbd(t, "↵")).child("card").child(kbd(t, "C")).child("chat").child(kbd(t, "Wheel")).child("zoom"));
}
const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const COL_SHORT = { backlog: "Backlog", todo: "To do", doing: "Doing", review: "Review", blocked: "Blocked", done: "Done" };
function card(t, G, f) {
  const p = S.pos[f.key];
  const CW = 312;
  const gx = G.ox + p.u * G.iw, gy = G.oy + p.v * G.ih;
  const off = Math.max(G.g * 0.8, 80); // clear of the ghost and its name label
  const right = gx + off + CW < G.W - T.sp.lg;
  const left = right ? gx + off : gx - off - CW;
  const top = clamp(gy - G.gh - 40, 60, Math.max(60, G.H - S.cardH - T.sp.lg));
  const counts = Object.fromEntries(COLS.map((c) => [c, f.mine.filter((x) => x.status === c).length]));
  const order = { doing: 0, blocked: 1, review: 2, todo: 3, backlog: 4 };
  const top3 = f.mine.filter((x) => x.status !== "done").sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || (a.id ?? 0) - (b.id ?? 0)).slice(0, 3);
  const c = STATE_C[f.state];
  const nt = !f.cur ? nextTask(f.p, f.a.name) : null;
  const stopped = !f.live;
  return v_flex().id("mp-map-card").absolute().left(Math.round(clamp(left, T.sp.lg, G.W - CW - T.sp.lg))).top(Math.round(top)).w(CW)
    .rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_lg().overflow_hidden()
    .on_mouse_down("left", stopDown)
    .on_size_change((size, cx) => { if (Math.abs(size.height - S.cardH) > 4) { S.cardH = size.height; cx.notify(); } })
    // Header: the ghost, name, project · status.
    .child(h_flex().px(T.pad.card).pt(T.pad.card).pb(T.sp.md).gap(T.sp.md).items_center()
      .child(h_flex().flex_none().size(36).rounded(T.r.panel).bg(alpha(colorFor(`agent:${f.a.name}`), "33")).items_center().justify_center()
        .child(image(ghostImg(f.a.name, stopped)).w(24).h(29)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(T.text.base).font_semibold().child(f.a.name))
        .child(h_flex().gap(T.sp.sm).items_center().min_w(0)
          .child(div().flex_none().size(T.dot).rounded(2).bg(f.p.loose ? "#5f7f76" : f.p.color ?? colorFor(`project:${f.p.name}`)))
          .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(f.p.loose ? "loose agent" : f.p.name))
          .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("·"))
          .child(div().flex_none().size(T.dot).rounded_full().bg(c))
          .child(div().flex_none().text_size(T.text.xs).font_medium().text_color(c).child(STATE_EN[f.state]))))
      .child(iconButton(t, "mp-map-card-x", "x", (_e, cx) => select(null, cx), "Close  (Esc)", { size: 22 })))
    // Now: current task + progress (or what is next).
    .child(v_flex().px(T.pad.card).pb(T.sp.md).gap(T.sp.xs)
      .child(div().text_size(T.text.xs).font_medium().text_color(t.dim).child(f.cur ? "Now" : nt ? "Next" : "Now"))
      .child(h_flex().id("mp-map-card-cur").gap(T.sp.sm).items_center().min_w(0).when(Boolean(f.cur || nt), (e) => e.cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click(() => openTaskPanel(f.p.slug, (f.cur ?? nt).id)))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(f.cur || nt ? t.foreground : t.dim)
          .child(f.cur ? `#${f.cur.id} ${f.cur.title}` : nt ? `#${nt.id} ${nt.title}` : "No task"))
        .when(Boolean(f.cur), (e) => e.child(div().flex_none().text_size(T.text.xs).text_color(t.muted).child(`${Math.round(f.cur.progress ?? 0)}%`))))
      .when(Boolean(f.cur), (e) => e.child(meter(t, f.cur.progress ?? 0, f.cur.status === "blocked" ? BAD : OK, 4)))
      .when(f.cur?.status === "blocked" && Boolean(f.cur?.blocked_reason), (e) => e.child(div().text_size(T.text.xs).text_color(BAD).whitespace_normal().child(f.cur.blocked_reason))))
    // Mini kanban: one count per column, then its top 3 open tasks.
    .child(v_flex().mx(T.pad.card).mb(T.sp.md).p(T.sp.sm).gap(T.sp.sm).rounded(T.r.ctrl).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(T.sp.xxs).children(COLS.map((col) => v_flex().flex_1().min_w(0).gap(T.sp.xxs).items_center()
        .child(div().text_size(T.text.sm).font_medium().text_color(counts[col] ? t.foreground : t.dim).child(String(counts[col])))
        .child(div().h(3).w_full().rounded_full().bg(counts[col] ? TASK_COLOR[col] : t.border))
        .child(div().w_full().text_center().truncate().text_size(T.text.micro).text_color(t.dim).child(COL_SHORT[col])))))
      .children(top3.map((x) => h_flex().id(`mp-map-card-t-${x.id}`).h(T.h.rowDense - 6).px(T.sp.xs).gap(T.sp.sm).items_center().rounded(T.r.chip).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`${TASK_EN[x.status] ?? x.status} · open the task`).on_click(() => openTaskPanel(f.p.slug, x.id))
        .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[x.status] ?? t.dim))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${x.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.foreground).child(x.title))))
      .when(top3.length === 0, (e) => e.child(div().px(T.sp.xs).text_size(T.text.xs).text_color(t.dim).child("No open tasks"))))
    // Actions.
    .child(h_flex().px(T.pad.card).pb(T.pad.card).gap(T.sp.sm).items_center().flex_wrap()
      .child(button(t, "mp-map-chat", "Chat", (_e, cx) => chatWith(f, cx), { small: true, primary: true, iconName: "messages" }))
      .child(button(t, "mp-map-task", "Assign task", () => assign(f), { small: true, iconName: "plus" }))
      .child(button(t, "mp-map-open", "Open", () => openPage(f), { small: true, ghost: true }))
      .child(div().flex_1())
      .child(iconButton(t, "mp-map-ss", stopped ? "play" : "square", (_e, cx) => {
        if (stopped) ask(`Start ${f.a.name}?`, "It reads its tasks and inbox first.", "Start", (cx) => startStop(f, cx, "start"));
        else ask(`Stop ${f.a.name}?`, f.cur ? `It is on #${f.cur.id} ${f.cur.title}; the task stays assigned.` : "Its terminal is closed.", "Stop", (cx) => startStop(f, cx, "stop"), true);
        cx.notify();
      }, stopped ? "Start agent" : "Stop agent", { size: T.h.btnSm, filled: true, color: stopped ? OK : BAD })));
}
function confirmBar(t) {
  const c = S.confirm;
  return h_flex().id("mp-map-confirm").absolute().bottom(T.sp.xl).left(0).right(0).justify_center()
    .child(panel(t).p(T.sp.md).pl(T.pad.card).gap(T.sp.lg).items_center().max_w(560).on_mouse_down("left", stopDown)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(T.text.sm).font_medium().child(c.text))
        .when(Boolean(c.sub), (e) => e.child(div().truncate().text_size(T.text.xs).text_color(t.dim).child(c.sub))))
      .child(button(t, "mp-map-cf-no", "Cancel", (_e, cx) => { S.confirm = null; cx.notify(); }, { small: true, ghost: true }))
      .child(button(t, "mp-map-cf-yes", c.label, (_e, cx) => { S.confirm = null; c.go(cx); cx.notify(); }, { small: true, primary: !c.danger, danger: c.danger })));
}

// ------------------------------------------------------------ view
export function mapView(ws, t, cx) {
  if (Date.now() - S.at > 6000 && (!S.loading || Date.now() - S.loading > 60000)) refresh(cx);
  ensureTick(cx);
  const dev = shared("mp.devMapSel"); // design previews / dev bridge: { name, at } selects a ghost
  if (dev && dev.at !== S.devAt) { S.devAt = dev.at; S.pendingSel = dev.name ?? null; if (!dev.name) S.sel = null; }
  const all = S.projects.flatMap((p) => p.agents.map((a) => factsOf(p, a)))
    .sort((x, y) => RANK[x.state] - RANK[y.state] || x.a.name.localeCompare(y.a.name));
  const shown = all.slice(0, MAX);
  if (S.pendingSel) { const f = shown.find((x) => x.a.name === S.pendingSel || x.key === S.pendingSel); if (f) { S.sel = f.key; S.kb = f.key; S.pendingSel = null; } }
  S.facts = shown.filter(inFilter).concat(shown.filter((f) => !inFilter(f)));
  if (S.sel && !shown.some((f) => f.key === S.sel)) S.sel = null;
  const by = {};
  for (const f of all) by[f.state] = (by[f.state] ?? 0) + 1;
  const zc = {};
  for (const f of shown) zc[f.zone] = (zc[f.zone] ?? 0) + 1;
  const sub = all.length ? `${by.working ?? 0} working · ${by.waiting ?? 0} waiting${by.blocked ? ` · ${by.blocked} blocked` : ""}` : "No agents";
  if (S.at && shared("mp.mapSub") !== sub) cx.spawn(async () => setShared("mp.mapSub", sub));
  const G = geo();
  const now = Date.now();
  // Design previews only (dev bridge): shared "mp.devMap" = { at, zoom?, drop?: { who, on: zone | agent } }.
  const dm = shared("mp.devMap");
  if (dm && dm.at !== S.devMapAt) {
    S.devMapAt = dm.at;
    if (!dm.drop) S.confirm = null;
    if (dm.zoom) { S.zoom = clamp(dm.zoom, 1, 2.6); S.pan = { x: 0, y: 0 }; }
    const f = dm.drop && shown.find((x) => x.a.name === dm.drop.who);
    const o = dm.drop && shown.find((x) => x.a.name === dm.drop.on);
    if (f) {
      for (const x of shown) posOf(x);
      const tp = o ? S.pos[o.key] : null, z = ZONES[dm.drop.on];
      const u = tp ? tp.u : z ? (z.rect[0] + z.rect[2]) / 2 : 0.5, v = tp ? tp.v : z ? (z.rect[1] + z.rect[3]) / 2 : 0.5;
      cx.timer.after(1, (cx) => drop(G, f, { u, v, lx: G.ox + u * G.iw, ly: G.oy + v * G.ih - G.gh / 2 }, cx));
    }
  }
  for (const f of shown) posOf(f);
  // Dragging: what the drop would do (highlight the zone sign / the ghost under the pointer).
  let dropZone = null, dropKey = null;
  if (S.drag?.moved) {
    const o = ghostAt(G, S.drag.lx, S.drag.ly, S.drag.key);
    if (o) dropKey = o.key; else dropZone = zoneAt(S.drag.u, S.drag.v);
  }
  const sel = S.sel ? shown.find((f) => f.key === S.sel) : null;
  // Draw order: lower on the map = in front (top-down depth); the dragged and selected ghost on top.
  const order = [...shown].sort((a, b) => {
    const lift = (f) => (S.drag?.moved && S.drag.key === f.key ? 2 : f.key === S.sel ? 1 : 0);
    return lift(a) - lift(b) || S.pos[a.key].v - S.pos[b.key].v;
  });
  return div().id("mp-map").relative().size_full().overflow_hidden().bg("#17221a")
    .on_size_change((size, cx) => {
      if (Math.abs(size.width - S.W) > 2 || Math.abs(size.height - S.H) > 2) { S.W = size.width; S.H = size.height; S.snapUntil = Date.now() + 400; cx.notify(); }
    })
    .on_mouse_down("left", (ev, cx) => {
      if (S.drag && Date.now() - S.drag.t < 80) return; // a ghost was pressed
      S.drag = null;
      if (S.sel || S.confirm) { S.sel = null; S.confirm = null; cx.notify(); }
      S.panStart = { x: ev.position.x, y: ev.position.y, px: S.pan.x, py: S.pan.y, moved: false };
    })
    .on_mouse_move((ev, cx) => {
      const lx = ev.local_position?.x ?? 0, ly = ev.local_position?.y ?? 0;
      if (S.drag) {
        const d = Math.hypot(ev.position.x - S.drag.x, ev.position.y - S.drag.y);
        if (!S.drag.moved && d < 5) return;
        if (!S.drag.moved) { S.drag.moved = true; if (S.sel === S.drag.key) S.sel = null; }
        S.drag.lx = lx; S.drag.ly = ly; // the pointer holds the ghost by its middle
        S.drag.u = clamp((lx - G.ox) / G.iw, 0, 1); S.drag.v = clamp((ly + G.gh / 2 - G.oy) / G.ih, 0, 1);
        cx.notify();
      } else if (S.panStart) {
        const dx = ev.position.x - S.panStart.x, dy = ev.position.y - S.panStart.y;
        if (!S.panStart.moved && Math.hypot(dx, dy) < 4) return;
        S.panStart.moved = true;
        S.pan = { x: S.panStart.px + dx, y: S.panStart.py + dy };
        S.snapUntil = Date.now() + 200;
        cx.notify();
      }
    })
    .on_mouse_up("left", (_ev, cx) => {
      const d = S.drag;
      S.panStart = null;
      if (d?.moved) { S.drag = null; const f = factByKey(d.key); if (f) drop(G, f, d, cx); }
      else if (d) cx.timer.after(1, () => { if (S.drag === d) S.drag = null; });
    })
    .on_hover((h, cx) => { if (!h && (S.drag || S.panStart)) { const moved = S.drag?.moved; S.drag = null; S.panStart = null; if (moved) cx.notify(); } })
    .on_scroll_wheel((ev, cx) => {
      const dy = ev.delta?.y ?? 0;
      if (!dy) return;
      const z0 = S.zoom, z1 = clamp(z0 * Math.exp(dy * 0.0025), 1, 2.6);
      if (Math.abs(z1 - z0) < 0.001) return;
      // Keep the point under the pointer where it is.
      const lx = ev.local_position?.x ?? G.W / 2, ly = ev.local_position?.y ?? G.H / 2;
      const u = (lx - G.ox) / G.iw, v = (ly - G.oy) / G.ih;
      S.zoom = z1;
      const iw = G.iw * (z1 / z0), ih = G.ih * (z1 / z0);
      S.pan = { x: (lx - u * iw) - (G.W / 2 - FOCUS[0] * iw), y: (ly - v * ih) - (G.H / 2 - FOCUS[1] * ih) };
      S.snapUntil = Date.now() + 400;
      cx.stop_propagation();
      cx.notify();
    })
    .child(image(MAP).absolute().left(Math.round(G.ox)).top(Math.round(G.oy)).w(Math.round(G.iw)).h(Math.round(G.ih)))
    .children(signs(t, G, zc, dropZone))
    .children(order.map((f) => ghostEl(t, G, f, now, f.key === dropKey)))
    .when(!S.at, (e) => e.child(h_flex().absolute().top(0).left(0).size_full().items_center().justify_center()
      .child(panel(t).px(T.pad.card).h(T.h.row).items_center().text_size(T.text.sm).text_color(t.muted).child("Gathering the ghosts…"))))
    .when(S.at > 0 && all.length === 0, (e) => e.child(h_flex().absolute().top(0).left(0).size_full().items_center().justify_center()
      .child(panel(t).p(T.pad.cardRoomy).gap(T.sp.lg).items_center().on_mouse_down("left", stopDown)
        .child(div().text_size(T.text.sm).text_color(t.muted).child("No agents yet: the village is empty."))
        .child(button(t, "mp-map-add", "Add an agent", () => openForm("loose-agent", {}), { small: true, primary: true, iconName: "plus" })))))
    .when(all.length > 0, (e) => e.child(chips(t, all)))
    .child(countsBar(t, by, all.length - shown.length))
    .child(legend(t))
    .when(Boolean(sel) && !S.drag?.moved, (e) => e.child(card(t, G, sel)))
    .when(Boolean(S.confirm), (e) => e.child(confirmBar(t)));
}
