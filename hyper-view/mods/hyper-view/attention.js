// Attention: who needs you right now. An agent waits when its live status is "blocked" (waiting for
// input) or it has an open question/approval in the Mailbox. The list is published as
// shared("mp.waiting") = [{ k, slug, project, name, why: "blocked"|"ask"|"approval", text, address? }]
// (only when it changes), so avatars get an amber ring (lib.agentAvatar), project rows a count badge,
// and Ctrl+J / the palette "Jump to next waiting" cycles through them (cmux-style "jump to latest").
import { shared, setShared, run } from "herdr";
import { appActive, demo, listProjects, liveAgent, selectProject, showCenter, openMailbox, toast, claimJob, repeat } from "./lib.js";
import { loadMailbox } from "./mailbox.js";

let started = false;
let projects = [];
let mail = [];

export function startAttention(cx) {
  const alive = claimJob("attention"); // a hot reload supersedes the old build's timer
  started = true;
  let tick = 0, busy = 0;
  const step = (cx) => {
    if (!alive() || (busy && Date.now() - busy < 60000)) return; // one step at a time
    busy = Date.now();
    cx.spawn(async () => {
    try {
      // Live statuses are cheap (every 3 s); the mailbox reads every project's files (every 30 s).
      // (every 90 s while the window is in the background)
      if (tick++ % (appActive() ? 10 : 30) === 0) {
        projects = await listProjects();
        const { items, done } = await loadMailbox();
        mail = items.filter((it) => !it.auto && !done.has(it.id) && (it.kind === "ask" || it.kind === "approval"));
      }
      publish();
    } catch {}
    busy = 0;
    });
  };
  step(cx);
  repeat(cx, 3000, (cx) => step(cx), alive);
}

// One entry per agent: live "blocked" first (newest need), then open questions, newest first.
export function waitingNow() {
  const out = new Map();
  for (const p of projects) for (const a of p.agents ?? []) {
    const live = liveAgent(p, a.name);
    if (live?.status === "blocked") out.set(`${p.slug}:${a.name}`, { k: `${p.slug}:${a.name}`, slug: p.slug, project: p.loose ? a.name : p.name, name: a.name, why: "blocked", text: "Waiting for your input", address: live.address, ts: "~" });
  }
  for (const it of mail) {
    const k = `${it.slug}:${it.from}`;
    if (out.has(k)) continue;
    out.set(k, { k, slug: it.slug, project: it.proj?.loose ? it.from : it.proj?.name ?? it.slug, name: it.from, why: it.kind, text: String(it.text ?? "").slice(0, 120), ts: String(it.ts ?? "") });
  }
  return [...out.values()].sort((a, b) => b.ts.localeCompare(a.ts)).map(({ ts, ...w }) => w);
}

function publish() {
  const list = waitingNow();
  if (JSON.stringify(shared("mp.waiting") ?? []) !== JSON.stringify(list)) setShared("mp.waiting", list);
}

// Opens where you answer: the live terminal (blocked agent), the Mailbox (question/approval), or the
// agent's detail (demo: no real terminal).
export function openWaiting(w) {
  if (!w) return;
  if (w.why === "blocked" && w.address && !demo()) { run("agent.focus", { terminal: w.address }); showCenter("mp-terms"); return; }
  if (w.why !== "blocked") { openMailbox(); showCenter("mp-view"); return; }
  selectProject(w.slug, "agents");
  setShared("mp.openAgent", { slug: w.slug, name: w.name, at: Date.now() });
  showCenter("mp-view");
}

// Ctrl+J: next waiting agent after the one jumped to last (wraps around).
export function jumpNextWaiting() {
  const list = shared("mp.waiting") ?? [];
  if (!list.length) { toast("Nobody is waiting", "No agent needs you right now."); return; }
  const i = list.findIndex((w) => w.k === globalThis.__hvWaitLast);
  const w = list[(i + 1) % list.length];
  globalThis.__hvWaitLast = w.k;
  openWaiting(w);
}
