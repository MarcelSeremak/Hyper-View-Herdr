// Supervisor: keeps agents with work running, and lets agents see each other's status.
// Every 30 s, for each project that is not paused:
//  - writes projects/<slug>/status.json (status of every agent) so `hp agent list` can show it;
//  - an agent that is not running but has tasks in To Do / In Progress is started again
//    ("resume your tasks"); Backlog never wakes an agent;
//  - a running idle agent that got a new task is nudged;
//  - safety: at most 3 restarts per agent in 15 min, then it stops trying and tells you (Mailbox).
//  - handoff: the last terminal lines of each live agent are cached (handoff/<agent>.txt) and put,
//    with the last notes of its In Progress task, into the restart prompt;
//  - a task whose dependencies (task.after) all got done is announced to its owner;
//  - limits guard: no auto-restart while the agent's provider has < 10% left (told once per 30 min).
//  - a stopped agent is also started (once per message, same limits) when the human is waiting for
//    it: a direct message, or a team message without @mentions when it is the lead (leadOf).
//  - collaboration: an idle agent with nothing In Progress is pointed at `hp ready` work (once per change,
//    at most every 10 min); a "working" agent with no output/task change for 20 min is asked whether it is
//    stuck, and ty is told 15 min later; expired task claims of agents that will not be restarted go back
//    to the board (hp task release --pool), an idle owner is asked to renew or release.
//  - epics: an epic counts as the lead's open work only while it needs a plan (not submitted / sent back); a new
//    epic nudges an idle lead to plan it (hp epic plan), a stopped lead is started for it.
//  - owner nudges: every few seconds the human's queued task changes (projects/<slug>/nudges.json, written by hp
//    task set|move|assign --as ty) older than 5 s are sent (hp nudges flush: one direct message per task) and an
//    idle owner's terminal is nudged.
// Paused projects and agents with autorestart: false are left alone.
import { hc, shared } from "herdr";
import * as fs from "fs/promises";
import { listProjects, loadProject, loadEvents, liveAgent, startAgent, projectDir, projectsRoot, hp, toast, demo, claimJob, repeat, leadOf, mentionsOf, sendToAgent, writeOutside } from "./lib.js";

const EVERY = 60000;
const WINDOW = 15 * 60 * 1000;
const MAX_RESTARTS = 3;
const ACTIVE = new Set(["todo", "doing"]);
const isEpic = (x) => x?.kind === "epic";
// An epic is work for its lead only until the plan is submitted (its tasks are the work after that).
const needsPlan = (x) => isEpic(x) && x.status !== "done" && x.plan !== "pending" && x.plan !== "approved";

const restarts = {};   // "slug/agent" -> [timestamps]
const gaveUp = {};     // "slug/agent" -> true once reported
const seen = {};       // "slug/agent" -> { status, since }
const knownTasks = {}; // "slug/agent" -> Set of task ids already nudged about
const contNudged = {}; // "slug/agent" -> last "continue your In Progress task" nudge
const msgSeen = {}; // slug -> highest event id already looked at (new direct messages wake idle agents)
const tails = {};      // "slug/agent" -> last terminal lines (string)
const waiting = {};    // "slug#id" -> true while the task waits for unfinished dependencies
let limitWarned = {};  // provider -> ts of last "limit low" message
let started = false;
const woke = {};       // "slug/agent" -> id of the human message it was last started for
const bootAt = Date.now() - 60000;
const ASK_FRESH = 30 * 60 * 1000;

// Collaboration (hp ready / claim leases): idle agents are pointed at ready work, quiet "working" agents
// are asked whether they are stuck (then ty is told), expired claims of agents that will not come back
// are returned to the board.
const IDLE_READY = 2 * 60 * 1000, READY_EVERY = 10 * 60 * 1000;
const STUCK = 20 * 60 * 1000, STUCK_TELL = 15 * 60 * 1000;
const POOL = new Set(["", "team", "any"]);
const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 };
const readyNudged = {};  // "slug/agent" -> { sig, ts }
const activity = {};     // "slug/agent" -> { sig, ts } (normalized terminal tail, last change)
const stuck = {};        // "slug/agent" -> { asked, told }
const leaseSeen = {};    // "slug#id" -> lease.until already handled
const leaseHolder = (x) => (x.lease && x.lease.until && new Date(x.lease.until).getTime() > Date.now() ? x.lease.by ?? "" : "");
// Same rule as hp's Ready-Tasks: To Do, dependencies done, mine or unassigned, not claimed by someone else.
export function readyFor(p, name) {
  const done = (d) => { const y = p.tasks.find((z) => String(z.id) === String(d)); return !y || y.status === "done"; };
  return p.tasks
    .filter((x) => x.status === "todo" && !isEpic(x) && (x.agent === name || POOL.has(x.agent ?? "")) && (Array.isArray(x.after) ? x.after : []).every(done) && ["", name].includes(leaseHolder(x)))
    .sort((a, b) => (PRIO[a.priority] ?? 2) - (PRIO[b.priority] ?? 2) || (a.agent === name ? 0 : 1) - (b.agent === name ? 0 : 1) || Number(a.id) - Number(b.id));
}
// Terminal tail without the parts that change while a model is just "thinking" (timers, token counts, spinners).
const normTail = (s) => String(s ?? "").split("\n").filter((l) => !/interrupt|tokens|thinking|\besc\b/i.test(l)).join("\n").replace(/[^A-Za-z\n ]+/g, "").replace(/[ \t]+/g, " ").trim();

const LIMIT_MIN = 10, LIMIT_EVERY = 30 * 60 * 1000;
// % left in the provider's main window (Claude: 5h, Codex: primary), or null when unknown.
function leftPct(app) {
  const L = shared("mp.limits");
  const w = app === "codex" ? (L?.codex?.ok ? L.codex.primary : null) : (L?.claude?.ok ? L.claude.five_hour : null);
  if (!w) return null;
  if (w.resets_at && new Date(w.resets_at).getTime() < Date.now()) return 100;
  return Math.max(0, 100 - (Number(w.used) || 0));
}
const clip = (s, n) => (s.length > n ? "…" + s.slice(s.length - n) : s);
function handoff(p, a, key) {
  const parts = [];
  const lines = String(tails[key] ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-20);
  if (lines.length) parts.push(`Your terminal before it stopped (last lines): ${clip(lines.join(" | "), 1000)}`);
  const cur = p.tasks.find((x) => x.agent === a.name && x.status === "doing");
  if (cur) {
    const items = [...(cur.history ?? []), ...(cur.notes ?? [])].filter((h) => h?.text).sort((x, y) => String(x.ts).localeCompare(String(y.ts))).slice(-3);
    if (items.length) parts.push(`Last notes on #${cur.id} ${cur.title}: ${clip(items.map((h) => `${h.by ?? "?"}: ${h.text}`).join("; "), 500)}`);
  }
  return parts.length ? " Handoff: " + clip(parts.join(" "), 1500) : "";
}

// The human's newest unanswered message that should wake this stopped agent, or null: to the agent
// directly, or a team message (no @mentions) when it is the lead. Only < 30 min old, after the app
// started, and each message wakes it once.
async function humanAsks(p, a, now) {
  const lead = leadOf(p);
  const events = await loadEvents(p.slug);
  for (let i = events.length - 1; i >= 0 && i >= events.length - 200; i--) {
    const e = events[i];
    if (e.type !== "message") continue;
    if (e.from === a.name) return null; // it already answered
    if (e.from !== "ty") continue;
    const team = !e.to || e.to === "all";
    if (!(e.to === a.name || (team && a.name === lead && !mentionsOf(p, e.text).length))) continue;
    const ts = new Date(e.ts).getTime();
    if (now - ts > ASK_FRESH || ts < bootAt || woke[`${p.slug}/${a.name}`] === e.id) return null;
    return e;
  }
  return null;
}

export function startSupervisor(cx) {
  // One supervisor per process (a hot reload supersedes the old build's): two would start agents twice.
  const alive = claimJob("supervisor");
  started = true;
  let busy = 0; // one pass at a time
  const tick = (cx) => {
    if (!alive() || (busy && Date.now() - busy < 5 * 60 * 1000)) return;
    busy = Date.now();
    cx.spawn(async () => { try { await runOnce(); } catch {} busy = 0; });
  };
  cx.timer.after(8000, (cx) => tick(cx));
  repeat(cx, EVERY, (cx) => tick(cx), alive);
  // Owner nudges: a cheap file check every 5 s; hp runs only when something is due.
  let flushing = 0;
  repeat(cx, 5000, (cx) => {
    if (!alive() || (flushing && Date.now() - flushing < 60000)) return;
    flushing = Date.now();
    cx.spawn(async () => { try { await flushNudges(); } catch {} flushing = 0; });
  }, alive);
}

// The human's task changes queued by hp (nudges.json): 5 s after the last change of a task, one direct message to
// its owner (hp nudges flush), and the owner's terminal is nudged when it is idle. chat.js skips its own
// "you have new messages" nudge for these (globalThis.__hvNudged).
const NUDGE_WAIT = 5000;
async function flushNudges() {
  let slugs = [];
  try { slugs = await fs.readdir(projectsRoot()); } catch { return; }
  const N = (globalThis.__hvNudged ??= {});
  for (const slug of slugs) {
    let q;
    try { q = JSON.parse((await fs.readFile(`${projectDir(slug)}/nudges.json`, "utf8")).replace(/^\uFEFF/, "")); } catch { continue; }
    const due = Object.values(q ?? {}).filter((e) => e && Date.now() - Number(e.ts) >= NUDGE_WAIT);
    if (!due.length) continue;
    for (const e of due) N[`${slug}/${e.agent}`] = Date.now();
    const r = await hp(["nudges", "flush"], { p: slug, json: true, wait: String(NUDGE_WAIT / 1000) });
    if (!r.ok) continue;
    let sent = [];
    try { sent = JSON.parse(r.out || "[]"); } catch {}
    if (!Array.isArray(sent)) sent = [sent];
    if (!sent.length) continue;
    const p = await loadProject(slug);
    if (!p || p.status === "paused") continue;
    for (const m of sent) {
      N[`${slug}/${m.agent}`] = Date.now();
      const live = liveAgent(p, m.agent);
      if (live && (live.status === "idle" || live.status === "done")) sendToAgent(live.address, `Message from ty: ${m.text}`);
    }
  }
}

async function runOnce() {
  if (demo()) return;
  const now = Date.now();
  for (const p0 of await listProjects()) {
    const p = await loadProject(p0.slug);
    if (!p) continue;
    const status = {};
    // New messages for an agent that is not working (Marcel's answer, an approval decision, a teammate's handoff):
    // wake it, or it sleeps on them until something else happens (VDS TEST: "Approved #2" sat unread for 20 min).
    // Messages from before this app started are left alone (the agents' first look is hp inbox anyway).
    if (!p.loose || p.agents[0]?.autorestart === true) {
      const evs = await loadEvents(p.slug).catch(() => []);
      const maxId = evs.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
      const from = msgSeen[p.slug];
      msgSeen[p.slug] = maxId;
      // First look (app start / reload): messages of the last hour the agent has not reacted to yet (it wrote
      // nothing after them). Later looks: everything new.
      const unread = (e, i) => !evs.slice(i + 1).some((x) => x.from === e.to);
      if (p.status !== "paused" && (from == null || maxId > from)) {
        const fresh = evs.filter((e, i) => e.type === "message" && e.to && e.to !== "all" && e.from !== e.to
          && (from != null ? (Number(e.id) || 0) > from : now - new Date(e.ts).getTime() < 3600000 && unread(e, i)));
        for (const a of p.agents) {
          const mine = fresh.filter((e) => e.to === a.name);
          if (!mine.length) continue;
          const live = liveAgent(p, a.name);
          if (!live || live.status === "working") continue;
          const who = [...new Set(mine.map((e) => (e.from === "ty" ? "Marcel" : e.from)))].join(", ");
          const ap = mine.some((e) => /^(Approved|Rejected) #\d+/.test(e.text ?? ""));
          globalThis.__hvNudged = { ...(globalThis.__hvNudged ?? {}), [`${p.slug}/${a.name}`]: now };
          sendToAgent(live.address, `New message${mine.length > 1 ? "s" : ""} for you from ${who}${ap ? " (an approval decision)" : ""}. Run: hp inbox --as ${a.name}${ap ? `, then continue the task it unblocks (hp approvals --as ${a.name})` : ""}.`);
        }
      }
    }
    // Dependencies: tell the owner when the last one is done (only on change, not on the first look).
    for (const x of p.tasks) {
      const k = `${p.slug}#${x.id}`;
      const deps = Array.isArray(x.after) ? x.after : [];
      const w = x.status !== "done" && deps.some((d) => { const y = p.tasks.find((z) => String(z.id) === String(d)); return y && y.status !== "done"; });
      if (waiting[k] && !w && deps.length && x.status !== "done" && x.agent && p.status !== "paused" && !p.loose) {
        const live = liveAgent(p, x.agent);
        if (live && live.status !== "working") sendToAgent(live.address, `Task #${x.id} ${x.title} is unblocked (all dependencies done). Run: hp task show ${x.id} --as ${x.agent}`);
      }
      waiting[k] = w;
      // Expired claim (lease) of an In Progress task: an owner that will not be restarted (removed, manual stop,
      // autorestart off, gave up) loses it to the board; an idle owner is asked to renew or release it.
      const until = x.status === "doing" && x.lease?.until ? new Date(x.lease.until).getTime() : 0;
      if (until && until < now && leaseSeen[k] !== x.lease.until && p.status !== "paused" && !p.loose) {
        const owner = p.agents.find((a) => a.name === x.agent);
        const live = owner ? liveAgent(p, owner.name) : null;
        if (!live || live.status !== "working") {
          leaseSeen[k] = x.lease.until;
          if (!owner || owner.autorestart === false || gaveUp[`${p.slug}/${owner.name}`]) {
            await hp(["task", "release", String(x.id)], { p: p.slug, as: "hp", pool: true, note: `claim expired; ${x.agent || "owner"} is not running` }).catch(() => {});
          } else if (live) {
            sendToAgent(live.address, `Your claim on #${x.id} ${x.title} expired. Still on it: hp task claim ${x.id} --as ${owner.name} (renews). Not: hp task release ${x.id} --as ${owner.name} --pool --note "where it stands"`);
          }
        }
      }
    }
    for (const a of p.agents) {
      const key = `${p.slug}/${a.name}`;
      const live = liveAgent(p, a.name);
      const st = live ? live.status ?? "idle" : "stopped";
      if (seen[key]?.status !== st) seen[key] = { status: st, since: new Date(now).toISOString() };
      const mine = p.tasks.filter((x) => x.agent === a.name && ACTIVE.has(x.status) && (!isEpic(x) || needsPlan(x)));
      const plans = mine.filter(needsPlan);
      const planHint = plans.length ? ` Epic${plans.length > 1 ? "s" : ""} waiting for your plan: ${plans.map((x) => `#${x.id} ${x.title} (hp epic plan ${x.id} --as ${a.name})`).join("; ")}.` : "";
      status[a.name] = { status: st, since: seen[key].since, open: mine.length };
      // Loose agents: only when Auto-restart was switched on for them (agent page); project agents: unless off.
      if (p.status === "paused" || (p.loose && a.autorestart !== true)) continue;

      if (!live) {
        // No open tasks: still start it when the human is waiting for its answer (lead: team message).
        const ask = !mine.length && a.autorestart !== false && !gaveUp[key] ? await humanAsks(p, a, now) : null;
        if ((!mine.length && !ask) || a.autorestart === false || gaveUp[key]) continue;
        const recent = (restarts[key] ?? []).filter((ts) => now - ts < WINDOW);
        if (recent.length >= MAX_RESTARTS) {
          gaveUp[key] = true;
          await hp(["say", `${a.name} keeps stopping (${MAX_RESTARTS} restarts in 15 min) and still has ${mine.length} open task${mine.length === 1 ? "" : "s"}. Auto-restart paused; start it from the agent page when fixed.`],
            { p: p.slug, as: a.name, to: "ty" }).catch(() => {});
          // No toast here: the message to "ty" above is picked up by notifier.js (respects the Mailbox bell).
          continue;
        }
        // Limits guard: do not burn a restart when the provider is (almost) out; resumes by itself.
        const app = a.app === "codex" ? "codex" : "claude";
        const lp = leftPct(app);
        if (lp != null && lp < LIMIT_MIN) {
          if (!limitWarned[app] || now - limitWarned[app] > LIMIT_EVERY) {
            limitWarned[app] = now;
            const name = app === "codex" ? "Codex" : "Claude";
            // No toast: the message to "ty" is shown by notifier.js (respects the Mailbox bell).
            await hp(["say", `${name} has only ${Math.round(lp)}% left in its main window. Auto-restart of ${a.name} (and other ${name} agents) is on hold until the limit resets.`],
              { p: p.slug, as: a.name, to: "ty" }).catch(() => {});
          }
          continue;
        }
        restarts[key] = [...recent, now];
        if (!tails[key]) tails[key] = await fs.readFile(`${projectDir(p.slug)}/handoff/${a.name}.txt`, "utf8").catch(() => "");
        if (ask) {
          woke[key] = ask.id;
          startAgent(p, a, `You were started because the human wrote ${ask.to === a.name ? "to you" : "to the whole team and you are the team lead (you answer for the team)"} and is waiting for an answer. Run: hp inbox --as ${a.name}, answer with hp say --to ty, and create tasks if work is needed.${handoff(p, a, key)}`, { quiet: true });
        } else {
          startAgent(p, a, `You were restarted because you still have open tasks. Run: hp task list --as ${a.name}, hp inbox --as ${a.name}, then continue the task that is In Progress (or start the next To Do).${planHint}${handoff(p, a, key)}`, { quiet: true });
        }
        status[a.name] = { status: "starting", since: new Date(now).toISOString(), open: mine.length };
        continue;
      }
      // Running: cache the terminal tail for a later handoff; forget old failures; nudge an idle agent.
      try {
        const out = (await hc(["read", live.address, "--lines", "40"])).stdout ?? "";
        if (out.trim() && out !== tails[key]) {
          tails[key] = out;
          await writeOutside(`${projectDir(p.slug)}/handoff/${a.name}.txt`, out); // ~/.herdr: not writable with fs
        }
      } catch {}
      if (st === "working") { delete gaveUp[key]; delete restarts[key]; }
      // Activity: the normalized terminal tail or the agent's In Progress task changed.
      const doing = mine.filter((x) => x.status === "doing");
      const actSig = normTail(tails[key]) + "|" + doing.map((x) => `${x.id}:${x.updated ?? ""}:${x.progress ?? 0}`).join(",");
      if (!activity[key] || activity[key].sig !== actSig || st !== "working") { activity[key] = { sig: actSig, ts: now }; delete stuck[key]; }
      else {
        const quiet = now - activity[key].ts;
        const sk = stuck[key] ?? (stuck[key] = {});
        if (quiet > STUCK && !sk.asked) {
          sk.asked = now;
          sendToAgent(live.address, `Supervisor: no visible progress for ${Math.round(quiet / 60000)} min. If you are stuck, say so: hp task block <id> --as ${a.name} --reason "..." or hp say --to <agent|ty> --as ${a.name} "...". If a long command is running, carry on and run hp task progress <id> <pct> --as ${a.name} when it ends.`);
        } else if (sk.asked && !sk.told && now - sk.asked > STUCK_TELL) {
          sk.told = now;
          await hp(["say", `${a.name} has looked stuck for ${Math.round(quiet / 60000)} min (working, no output or task change; asked ${Math.round((now - sk.asked) / 60000)} min ago without effect)${doing.length ? ` on #${doing[0].id} ${doing[0].title}` : ""}. Check its terminal; restart or reassign (hp task handoff).`],
            { p: p.slug, as: a.name, to: "ty" }).catch(() => {});
        }
      }
      const ids = mine.map((x) => String(x.id));
      if (!knownTasks[key]) { knownTasks[key] = new Set(ids); continue; }
      // "done" = finished its turn while nobody looked (Codex then waits at its prompt): same as idle here.
      if (st === "idle" || st === "done") {
        const fresh = ids.filter((id) => !knownTasks[key].has(id));
        if (fresh.length) {
          fresh.forEach((id) => knownTasks[key].add(id));
          const ep = plans.filter((x) => fresh.includes(String(x.id))), plain = fresh.filter((id) => !ep.some((x) => String(x.id) === id));
          if (ep.length) sendToAgent(live.address, `New epic${ep.length > 1 ? "s" : ""} for you to plan: ${ep.map((x) => `#${x.id} ${x.title}`).join("; ")}. Break it into tasks: hp epic plan ${ep[0].id} --as ${a.name}`);
          if (plain.length) sendToAgent(live.address, `New task${plain.length > 1 ? "s" : ""} for you: ${plain.map((id) => "#" + id).join(", ")}. Run: hp ready --as ${a.name}, then hp task claim <id> --as ${a.name}`);
          readyNudged[key] = { sig: readyFor(p, a.name).map((x) => x.id).join(","), ts: now };
        } else if (!doing.length && now - new Date(seen[key].since).getTime() > IDLE_READY) {
          // Idle with nothing In Progress: point it at ready work (its own To Do or unassigned team tasks).
          const ready = readyFor(p, a.name).slice(0, 3);
          const sig = ready.map((x) => x.id).join(",");
          const last = readyNudged[key];
          // Again every READY_EVERY while it stays idle with ready work (once was not enough: an ignored nudge
          // left the agent idle for good).
          if (ready.length && (!last || last.sig !== sig || now - last.ts > READY_EVERY)) {
            readyNudged[key] = { sig, ts: now };
            sendToAgent(live.address, `You are idle and there is ready work: ${ready.map((x) => `#${x.id} ${x.title}`).join("; ")}. Run: hp ready --as ${a.name}, then hp task claim <id> --as ${a.name}`);
          }
        } else if (doing.length && now - new Date(seen[key].since).getTime() > IDLE_READY) {
          // Idle with a task In Progress (it ended its turn, e.g. waiting for something): continue it, or say why not.
          const last = contNudged[key];
          if (!last || now - last > READY_EVERY) {
            contNudged[key] = now;
            sendToAgent(live.address, `You are idle but #${doing[0].id} ${doing[0].title} is In Progress. Continue it now. If it waits for someone: hp task block ${doing[0].id} --as ${a.name} --reason "...", then take other ready work (hp ready --as ${a.name}). Check hp inbox --as ${a.name} first.`);
          }
        }
      }
    }
    // hp agent list reads it ("unknown" before: fs may not write in ~/.herdr).
    await writeOutside(`${projectDir(p.slug)}/status.json`, JSON.stringify({ updated: new Date(now).toISOString(), agents: status }, null, 2));
  }
}

// After a manual Start, let the supervisor try again.
export function resetRestarts(slug, name) { delete restarts[`${slug}/${name}`]; delete gaveUp[`${slug}/${name}`]; }
// A manual Stop means "leave it stopped" until it is started again by hand.
export function markManualStop(slug, name) { gaveUp[`${slug}/${name}`] = true; }
