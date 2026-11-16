// Guided tour ("Tutorial" button next to the logo, or Ctrl+K → Start tutorial). Loads the demo data,
// then Codie walks you through the app: each step opens the right view, dims everything except the
// part it is about (a soft rounded spotlight that glides between steps) and explains it in one or two
// plain sentences. Keys: → / Enter next, ← back, Esc close. Closing puts demo mode back as it was.
//
// Patterns (Driver.js / Shepherd.js / Linear-style onboarding): one dim layer with a rounded cut-out
// (Driver: stageRadius 5, stagePadding 10, overlayOpacity .7, 400 ms animate), the popover beside the
// highlight that flips side when it doesn't fit and is centred when the target is missing, arrow keys +
// Esc, a step count with a progress bar, and a quiet "Skip" link.
//
// Sizing. The tour is one frameless overlay window opened at a share of 1×1 of the window. Herdr sizes
// that window in window units but draws a mod overlay scaled by the zoom (settings().zoom), so at zoom
// 0.9 the box only reaches 90 % of the window. So: the root reports its box (rootW × rootH, in overlay
// units); the whole window is rootW / zoom × rootH / zoom overlay units, and we draw the dim layer over
// all of it (overlay children are not clipped). Clickable parts (the bubble) stay inside the root box.
// Overlay units equal layout px (both scale with zoom); sizes measured by the app's parts
// (lib.js measure(), window units) are divided by the zoom.
import { T } from "./tokens.js";
import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, shared, setShared, openOverlay, closeOverlay, run, settings, layout } from "herdr";
import { MOD, showCenter, button, iconButton, icon, tourSizes, rememberFocus } from "./lib.js";
import { LEFT, RIGHT } from "./toolbar.js";

const BW = 340;          // bubble width
const GHOST = 56;        // Codie
const GW = BW + GHOST + 8;
const GAP = 14;          // highlight ↔ bubble
const PAD = 6;           // spotlight padding around the part
const R = 10;            // spotlight corner radius
const B = 4000;          // the dim layer is the spotlight's border: wide enough to cover any window
const M = 16;            // margin to the window edge
const MOVE = { duration: 400, easing: "ease-in-out" };
const DIM = "#05070ab3";

const zoomNow = () => { try { return Number(settings()?.zoom) || 1; } catch { return 1; } };

// px of a layout node by id (the live layout, so other parts may change it), else the fallback.
function layoutPx(id, fallback) {
  try {
    const walk = (n) => {
      if (!n || typeof n !== "object") return null;
      if (n.id === id) return n;
      for (const c of n.children ?? []) { const f = walk(c); if (f) return f; }
      for (const c of n.floating ?? []) { const f = walk(c); if (f) return f; }
      return walk(n.root);
    };
    const node = walk(layout());
    const px = Number(node?.size?.px);
    return node?.hidden ? 0 : Number.isFinite(px) ? px : fallback;
  } catch { return fallback; }
}

// Where things are, in overlay units, from the sizes the parts report about themselves.
// Every key is optional: a part that isn't measured (moved, renamed, hidden) has no rect, and the
// step then shows its bubble centred without a spotlight.
function geo(W, H, zm) {
  const raw = tourSizes();
  const m = (k) => (raw[k] && raw[k].w > 0 && raw[k].h > 0 ? { w: raw[k].w / zm, h: raw[k].h / zm } : null);
  const BAR = layoutPx("mp-status", 34);
  const out = {};
  const side = m("side");
  if (side) {
    // The sidebar block sits on the status bar; its parts are stacked from the top.
    // IDE style: an icon rail (side.rail) then the explorer tree; older builds: one column.
    const rail = m("side.rail"), explorer = m("side.explorer");
    const sTop = H - BAR - side.h, sx = (rail?.w ?? 0) + 6, sw = (explorer?.w ?? side.w - (rail?.w ?? 0)) - 12;
    if (rail) out.rail = [4, sTop + 4, rail.w - 8, side.h - 8];
    const end = sTop + side.h - (m("side.bottom")?.h ?? 0); // the scrolling middle ends here
    const clip = (y, h) => (y < end - 20 ? [sx, y, sw, Math.max(24, Math.min(h, end - y))] : null);
    let y = sTop;
    const search = m("side.search"), dash = m("side.dashboard");
    if (search) out.search = [sx, y, sw, search.h - 8];
    y += search?.h ?? 0;
    if (dash) out.dashboard = [sx, y, sw, dash.h];
    y += dash?.h ?? 0;
    for (const k of ["projects", "vms", "loose"]) {
      const s = m(`side.${k}`);
      if (!s) continue;
      const r = clip(y, s.h);
      if (r) out[k] = r;
      y += s.h;
    }
    const bottom = m("side.bottom");
    if (bottom) out.sideBottom = [sx, end, sw, bottom.h - 4];
  }
  const center = m("center"), chat = m("chat");
  if (chat) out.chat = [W - layoutPx("mp-chat-col", RIGHT.open) + 10, H - BAR - 10 - chat.h, chat.w, chat.h];
  if (center) {
    const cx = side ? side.w + 1 : out.chat ? out.chat[0] - 20 - center.w : 0;
    const top = H - BAR - center.h; // the view header ends here
    out.content = [cx + 12, top + 6, center.w - 24, center.h - 12];
    out.page = [cx + 12, 8, center.w - 24, H - BAR - 16];
    out.header = [cx + 12, 8, center.w - 24, Math.max(40, top - 12)];
  }
  out.bar = [0, H - BAR, W, BAR];
  return out;
}

const P = "demo-ecommerce";
const view = (v) => () => { setShared("mp.view", v); showCenter("mp-view"); };
const noPanel = () => setShared("mp.taskPanel", null);
const chatAll = () => setShared("mp.chatPick", { name: null, at: Date.now() });
// (openAgent name: null closes an open agent detail)
const project = (tab) => () => { noPanel(); view({ kind: "project", slug: P, tab })(); setShared("mp.openAgent", { slug: P, name: null, at: Date.now() }); };
const taskPanel = (id, tab) => () => { project("tasks")(); setShared("mp.taskPanel", { slug: P, id, tab, at: Date.now() }); };

// at: the part it is about (see geo()); side: where the bubble prefers to go; go(): opens the view;
// form: a real form shown in tutorial mode (nothing is saved).
const STEPS = [
  { title: "Hi, I'm Codie", go: view({ kind: "dashboard" }),
    text: "A two-minute tour with demo data — nothing real changes. Use → and ← to move, Esc to leave." },
  { title: "Needs you", at: "page", side: "right", go: view({ kind: "dashboard" }),
    text: "The Dashboard lists what waits on you first, then what's working, ready and done today. ↑ ↓ move, Enter opens, → shows actions." },
  { title: "Views on the left", at: "rail", side: "right", go: view({ kind: "dashboard" }),
    text: "The icons switch modes: Dashboard, Projects, Machines, Agents, Mailbox, Clipboard and Tokens. Projects, Machines and Agents open their own explorer next to the icons." },
  { title: "Command palette", side: "center", go: view({ kind: "dashboard" }),
    text: "Ctrl+K jumps to any project, agent, task or machine. Press → on a row to see what you can do with it." },
  { title: "Keyboard first", side: "center", go: view({ kind: "dashboard" }),
    text: "Ctrl+/ shows every shortcut. Alt+1–6 switches the project's views, Ctrl+Shift+↑ ↓ changes project, Ctrl+J jumps to the next agent waiting for you." },
  { title: "Projects", at: "projects", side: "right", go: project("overview"),
    text: "A project is one thing you build. Open it in the explorer: Overview, Agents, Tasks, Machines and Activity. + makes a new one." },
  { title: "Overview", at: "content", side: "below", go: project("overview"),
    text: "The project at a glance: live agents, open and blocked tasks, and what happened today." },
  { title: "Agents and risk", at: "content", side: "below", go: project("agents"),
    text: "Claude Code or Codex helpers. Each has a risk level: Careful asks before risky steps, Balanced asks only on production, Autonomous merges and deploys alone." },
  { title: "Add an agent", go: project("agents"), form: { kind: "agent-new", extra: { project: P }, w: 680 },
    text: "Pick the app, a role, a risk level and a first task — or add a whole team at once." },
  { title: "Tasks", at: "content", side: "below",
    go: () => { project("tasks")(); setShared("mp.devTaskMode", { mode: "kanban", at: Date.now() }); },
    text: "Agents move their own tasks: To Do → In Progress → Review → Done. Blocked means they wait for you." },
  { title: "Epics", at: "content", side: "below", go: project("epics"),
    text: "Big goals for the lead: it splits each into tasks and you approve the plan in the Mailbox. Every epic shows its plan state and progress; → lists its tasks." },
  { title: "Task workspace", at: "chat", side: "left", go: taskPanel(6, "overview"),
    text: "Click a task to open its workspace: Overview, Chat, Changes and Terminal." },
  { title: "Review and merge", at: "chat", side: "left", go: taskPanel(6, "changes"),
    text: "Changes shows the diff; comment on any line. Merge brings the branch into main, Archive cleans up its folder." },
  { title: "Project machines", at: "content", side: "below", go: project("machines"),
    text: "The servers this project's agents may use, with live CPU, memory and disk. Attach one you already have or add a new one." },
  { title: "Activity", at: "content", side: "below", go: project("activity"),
    text: "Every agent session as one run: what it worked on, how long, and how it ended — tests passed, committed or failed. Click a run for its key steps." },
  { title: "Team chat", at: "chat", side: "left", go: () => { project("overview")(); chatAll(); },
    text: "Agents talk to each other and to you here. When one asks, answer with Approve, Reject or Wait." },
  { title: "@mentions", at: "chat", side: "left", go: () => { project("overview")(); setShared("mp.chatPick", { name: "deploy-agent", at: Date.now() }); },
    text: "Type @ and a name to write to one agent. Click a name to see only its messages." },
  { title: "Agents", at: "loose", side: "right", go: () => { noPanel(); view({ kind: "project", slug: P, tab: "agent", agent: "deploy-agent", via: "agents" })(); },
    text: "All agents in one list, project ones with their project's badge. An agent's page shows its risk, auto-restart, what it does now and its recent runs." },
  { title: "Machines", at: "vms", side: "right", go: () => { noPanel(); view({ kind: "vm", name: "web-frontend-01", tab: "overview" })(); },
    text: "Your servers with live CPU, memory and disk. A lock means an agent is working there." },
  { title: "Editor", at: "page", side: "right", go: view({ kind: "vm", name: "web-frontend-01", tab: "overview" }),
    text: "Each machine has an Editor tab: a VS Code-like Neovim that edits its files over SSH, with a terminal below." },
  { title: "Mailbox", at: "page", side: "right", go: view({ kind: "mailbox" }),
    text: "Approvals and questions from every project land here. Approve, Reject or Reply — it goes straight to the agent." },
  { title: "Tokens & Access", at: "page", side: "right", go: view({ kind: "secrets" }),
    text: "GitHub and GitLab tokens are stored once, in Windows Credential Manager. Agents can use them but never read them." },
  { title: "You're ready", go: project("overview"),
    text: "Close the tour to get your own data back. Start it again any time: Ctrl+K → Start tutorial." },
];

const openTourWindow = () => openOverlay({ mod: MOD, props: { role: "tour" }, kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 } });

export function startTour() {
  if (shared("mp.tourPrevDemo") == null) setShared("mp.tourPrevDemo", Boolean(shared("mp.demo")));
  setShared("mp.demo", true);
  setShared("mp.folded", []);
  setShared("mp.explorer", null); // the tree shows every section (the tour points at Projects and Machines)
  setShared("mp.chatFull", false);
  if (shared(LEFT.key)) { setShared(LEFT.key, false); run("layout.resize", { id: LEFT.id, px: LEFT.open }); }
  if (shared(RIGHT.key)) { setShared(RIGHT.key, false); run("layout.resize", { id: RIGHT.id, px: RIGHT.open }); }
  setShared("mp.tourStep", 0);
  setShared("mp.tourJump", null);
  setShared("mp.devTpMenu", null);
  STEPS[0].go();
  if (globalThis.__hvTourId) { try { closeOverlay(globalThis.__hvTourId); } catch {} }
  rememberFocus("tour");
  globalThis.__hvTourId = openTourWindow();
}

// Dev bridge: jump to a step ("end" closes).
export function tourGo(n) { setShared("mp.tourJump", { n, at: Date.now() }); }

function endTour(overlay) {
  const prev = shared("mp.tourPrevDemo");
  setShared("mp.tourPrevDemo", null);
  setShared("mp.demo", Boolean(prev));
  setShared("mp.taskPanel", null);
  setShared("mp.chatPick", { name: null, at: Date.now() });
  // Land on the Dashboard (a project view without a slug showed "No project yet." even with projects).
  setShared("mp.view", { kind: "dashboard" });
  showCenter("mp-view");
  for (const id of new Set([overlay, globalThis.__hvTourId].filter(Boolean))) { try { closeOverlay(id); } catch {} }
  globalThis.__hvTourId = null;
}

// A spot for Codie + bubble that keeps the highlighted part visible. Area: [0, aw] × [0, ah] (the
// clickable box). Returns { x, y, r } — r is the spotlight, trimmed when a big part leaves no room.
function place(r, side, aw, ah, bh, W, H) {
  if (!r) return { x: Math.max(M, Math.min(aw - GW - M, (W - GW) / 2)), y: Math.max(M, Math.min(ah - bh - M, (H - bh) / 2)), r };
  const fits = (x, y) => x >= M && y >= M && x + GW <= aw - M && y + bh <= ah - M;
  const cx = (x) => Math.max(M, Math.min(aw - GW - M, x));
  const cy = (y) => Math.max(M, Math.min(ah - bh - M, y));
  const [rx, ry, rw, rh] = r;
  const c = {
    right: [rx + rw + PAD + GAP, cy(ry)],
    left: [rx - PAD - GAP - GW, cy(ry)],
    below: [cx(rx + rw / 2 - GW / 2), ry + rh + PAD + GAP],
    above: [cx(rx + rw / 2 - GW / 2), ry - PAD - GAP - bh],
  };
  for (const k of [side, "right", "left", "below", "above"]) {
    if (!c[k]) continue;
    const [x, y] = c[k];
    if (fits(x, y)) return { x, y, r };
  }
  // A big part: show its top and put the bubble under it (Driver.js does the same for tall elements).
  const keep = Math.min(rh, ah - M - bh - GAP - PAD - ry);
  if (keep >= Math.min(rh, 120)) return { x: cx(rx + rw / 2 - GW / 2), y: ry + keep + PAD + GAP, r: [rx, ry, rw, keep] };
  // Nothing free: the corner that covers the least of it.
  const over = ([x, y]) => Math.max(0, Math.min(x + GW, rx + rw) - Math.max(x, rx)) * Math.max(0, Math.min(y + bh, ry + rh) - Math.max(y, ry));
  const best = [[aw - GW - M, ah - bh - M], [M, ah - bh - M], [aw - GW - M, M], [M, M]].reduce((a, b) => (over(b) < over(a) ? b : a));
  return { x: best[0], y: best[1], r };
}

export class Tour {
  init(cx) {
    this.overlay = (props() ?? {}).overlay;
    this.jumpAt = shared("mp.tourJump")?.at; // ignore a jump left over from before this tour
    this.rootW = 0; this.rootH = 0; this.bh = 180; this.vis = true;
    const mine = () => !this.overlay || globalThis.__hvTourId === this.overlay;
    // Keys: overlays don't always get the keyboard, so bind our own context (palette.js pattern)
    // and focus the root on open (and again after each step, since views take focus).
    try { this.fh = cx.focus_handle(); } catch {}
    if (!globalThis.__hvTourKeys) {
      try {
        const list = [["right", "hv_tour_next"], ["enter", "hv_tour_next"], ["space", "hv_tour_next"], ["left", "hv_tour_prev"], ["escape", "hv_tour_close"]];
        cx.bind_keys(list.map(([keystroke, action]) => ({ keystroke, action, context: "HvTour" })));
        globalThis.__hvTourKeys = true;
      } catch (err) { console.warn("tour: key bindings", err); }
    }
    this.focusSoon(cx);
    // The window is sized when it opens (a share of the window): if the window changes size, open it
    // again. Zoom changes need nothing: render() reads the zoom. Timers stop once this isn't the tour.
    const t700 = cx.timer.every(700, () => {
      if (!mine()) { try { t700.cancel(); } catch {} return; }
      const vp = globalThis.window?.viewport_size?.();
      if (!vp || this.reopening || !this.rootW) return;
      if (Math.abs(vp.width - this.rootW) > 6 || Math.abs(vp.height - this.rootH) > 6) {
        this.reopening = true;
        this.closeForm();
        const old = this.overlay;
        globalThis.__hvTourId = openTourWindow();
        try { closeOverlay(old); } catch {}
      }
    });
    // Sizes reported by the app's parts change (data loads, panels move, zoom): keep following them.
    const t400 = cx.timer.every(400, (cx) => {
      if (!mine()) { try { t400.cancel(); } catch {} return; }
      const key = JSON.stringify(tourSizes()) + zoomNow();
      if (key !== this.lastRects) { this.lastRects = key; cx.notify(); }
    });
  }

  focusSoon(cx) { for (const ms of [30, 300, 900]) cx.timer.after(ms, () => { if (!this.formId) { try { this.fh?.focus(); } catch {} } }); }

  close() { if (this.closed) return; this.closed = true; this.closeForm(); endTour(this.overlay); }

  // Fade the text out, move, fade the new text in — so it is clear something changed.
  go(i, cx) {
    if (i >= STEPS.length) { this.close(); return; }
    const n = Math.max(0, i);
    if (n === (shared("mp.tourStep") ?? 0)) return;
    this.vis = false;
    this.closeForm();
    cx.notify();
    cx.timer.after(160, (cx) => {
      setShared("mp.tourStep", n);
      setShared("mp.chatFull", false);
      STEPS[n].go();
      this.vis = true;
      cx.notify();
      if (STEPS[n].form) cx.timer.after(450, (cx) => { if ((shared("mp.tourStep") ?? 0) === n) this.openForm(STEPS[n].form, cx); });
      this.focusSoon(cx);
    });
  }

  closeForm() { if (this.formId) { try { closeOverlay(this.formId); } catch {} this.formId = null; } this.formRect = null; }

  // The real form, in tutorial mode, beside the bubble (both centred together in the clickable box).
  openForm(f, cx) {
    const zm = zoomNow();
    const aw = this.rootW || 1600, ah = this.rootH || 900;
    const fw = f.w ?? 480, fh = Math.round(Math.min(ah - 2 * M, 760));
    const fx = Math.max(M, Math.round((aw - (fw + GAP + GW)) / 2)), fy = Math.max(M, Math.round((ah - fh) / 2));
    this.closeForm();
    this.formRect = [fx, fy, fw, fh];
    // Overlay sizes and spots are layout px (scaled by the zoom like this window), so pass them as they are.
    this.formId = openOverlay({ mod: MOD, props: { role: "form", kind: f.kind, tour: true, ...f.extra }, kind: "window", width: fw, height: fh, at: { x: Math.round(fx * zm), y: Math.round(fy * zm) } });
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const jump = shared("mp.tourJump");
    if (jump && jump.at !== this.jumpAt) {
      this.jumpAt = jump.at;
      if (jump.n === "end") cx.timer.after(10, () => this.close());
      else cx.timer.after(10, (cx) => this.go(jump.n, cx));
    }
    const i = Math.min(STEPS.length - 1, shared("mp.tourStep") ?? 0);
    const s = STEPS[i];
    const zm = zoomNow();
    // The whole window in overlay units, and the part of it this window really covers (clickable).
    const aw = this.rootW || 1600, ah = this.rootH || 900;
    const W = aw / zm, H = ah / zm;
    const AW = Math.min(aw, W), AH = Math.min(ah, H);
    const g = s.at ? geo(W, H, zm) : {};
    const target = s.at ? g[s.at] ?? null : null;
    const accent = String(t.accent).slice(0, 7);
    const last = i === STEPS.length - 1;
    globalThis.__hvTourDbg = { step: i, zoom: zm, root: [aw, ah], win: [W, H], target, missing: s.at && !target ? s.at : undefined, focused: (() => { try { return this.fh?.is_focused?.(); } catch { return null; } })() };

    const fr = this.formRect;
    let p;
    if (fr) p = { x: Math.min(AW - GW - M, fr[0] + fr[2] + GAP), y: Math.max(M, Math.min(AH - this.bh - M, fr[1] + 24)), r: null };
    else p = place(target, s.side, AW, AH, this.bh, W, H);
    const r = p.r;

    // Spotlight: one rounded box whose huge border is the dim layer, so the cut-out has soft corners
    // and glides (left/top/width/height transitions) from part to part. No part: it closes to a point.
    const [hx, hy, hw, hh] = r ? [r[0] - PAD, r[1] - PAD, r[2] + 2 * PAD, r[3] + 2 * PAD] : [W / 2, H / 2, 0, 0];
    const glide = (el) => el.transition("left", MOVE).transition("top", MOVE).transition("width", MOVE).transition("height", MOVE);
    const spot = glide(div().id("mp-tour-spot").absolute().left(hx - B).top(hy - B).w(hw + 2 * B).h(hh + 2 * B)
      .border(B).border_color(DIM).rounded(R + B));
    const ring = glide(div().id("mp-tour-ring").absolute().left(hx - 1).top(hy - 1).w(hw + 2).h(hh + 2).rounded(R + 1)
      .border_1().border_color(`${accent}cc`)).opacity(r ? 1 : 0).transition("opacity", MOVE);

    const ghost = div().relative().size(GHOST).flex_none().loop("top", { from: 0, to: -4, period: 2200 })
      .child(div().absolute().top(0).left(0).size_full().loop("opacity", { from: 1, to: 0, period: 900 }).child(image(icon("splash/arm-a")).size_full()))
      .child(div().absolute().top(0).left(0).size_full().loop("opacity", { from: 0, to: 1, period: 900 }).child(image(icon("splash/arm-b")).size_full()))
      .child(image(icon("splash/body")).absolute().top(0).left(0).size_full())
      .child(image(icon("splash/eyes-happy")).absolute().top(0).left(0).size_full())
      .child(image(icon("splash/mouth-smile")).absolute().top(0).left(0).size_full());

    const key = (k) => h_flex().px(4).h(16).flex_none().rounded(T.r.chip).border_1().border_color(t.border).bg(t.raised)
      .text_size(T.text.xs).text_color(t.muted).items_center().child(k);
    const bubble = v_flex().w(BW).rounded(T.r.dialog).bg(t.popover ?? t.surface).border_1().border_color(t.border).shadow_lg().overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - this.bh) > 2) { this.bh = size.height; cx.notify(); } })
      // Progress: a hairline across the top that fills smoothly.
      .child(div().w_full().h(2).bg(t.border)
        .child(div().id("mp-tour-progress").h_full().bg(t.accent).w(Math.round((BW * (i + 1)) / STEPS.length)).transition("width", MOVE)))
      .child(v_flex().id("mp-tour-text").px(16).pt(12).gap(6).opacity(this.vis ? 1 : 0).transition("opacity", { duration: 150 })
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(T.text.lg).font_semibold().text_color(t.foreground).child(s.title))
          .child(iconButton(t, "mp-tour-x", "x", () => this.close(), "Close (Esc)", { size: 22 })))
        .child(div().text_size(T.text.base).line_height(`${T.lh.base}px`).whitespace_normal().text_color(t.muted).child(s.text)))
      .child(h_flex().px(16).pt(12).pb(12).gap(8).items_center()
        .when(!last, (el) => el.child(div().id("mp-tour-skip").text_size(T.text.sm).text_color(t.dim ?? t.muted).cursor_pointer()
          .hover((st) => st.text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => this.close()).child("Skip tour")))
        .child(div().flex_1())
        .child(div().text_size(T.text.xs).text_color(t.dim ?? t.muted).child(`${i + 1} of ${STEPS.length}`))
        .when(i > 0, (el) => el.child(button(t, "mp-tour-prev", "Back", (_e, cx) => this.go(i - 1, cx), { small: true, ghost: true })))
        .child(button(t, "mp-tour-next", last ? "Done" : "Next", (_e, cx) => this.go(i + 1, cx), { small: true, primary: true })))
      .when(i === 0, (el) => el.child(h_flex().px(16).pb(12).gap(4).items_center().text_size(T.text.xs).text_color(t.dim ?? t.muted)
        .child(key("←")).child(key("→")).child(div().pr(8).child("move")).child(key("Esc")).child("close")));

    let root = div().id("mp-tour").size_full().relative()
      .key_context("HvTour")
      .on_action("hv_tour_next", (_e, cx) => this.go(i + 1, cx))
      .on_action("hv_tour_prev", (_e, cx) => this.go(i - 1, cx))
      .on_action("hv_tour_close", () => this.close())
      // Fallback only when the bindings couldn't be installed (else a key would act twice).
      .on_key_down((e, cx) => {
        if (globalThis.__hvTourKeys) return;
        if (e.key === "escape") this.close();
        else if (e.key === "right" || e.key === "enter") this.go(i + 1, cx);
        else if (e.key === "left") this.go(i - 1, cx);
      })
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.rootW) > 1 || Math.abs(size.height - this.rootH) > 1) { this.rootW = size.width; this.rootH = size.height; cx.notify(); }
      })
      .on_mouse_down("left", (_e, cx) => { try { this.fh?.focus(); } catch {} cx.stop_propagation(); });
    if (this.fh) root = root.track_focus(this.fh);
    return root
      .child(spot)
      .child(ring)
      .child(h_flex().id("mp-tour-bubble").absolute().left(p.x).top(p.y).gap(8).items_start().transition("left", MOVE).transition("top", MOVE)
        .child(ghost)
        .child(bubble));
  }
}
