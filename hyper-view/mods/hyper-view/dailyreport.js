// Daily report: once per day (the first time the app runs after 08:00) `hp report daily --all` sends each
// active project's summary of yesterday to the Mailbox (a message from "herdr" to you, thread
// daily-<date>; hp skips projects already reported, paused or loose ones, and days with nothing in them).
// ~/.herdr/daily-report.json remembers the day it ran, so restarts and several windows run it once.
// Runs in demo mode too: it only reads and writes real project files, never the demo data.
import { readTextFile, writeTextFile } from "herdr";
import { hp, herdrHome, claimJob, repeat } from "./lib.js";
import { dayOf } from "./activity.js";

const HOUR = 8;
const file = () => `${herdrHome()}/daily-report.json`;
const D = (globalThis.__hvDaily ??= { last: null, busy: false });

async function maybeRun() {
  const now = new Date();
  const today = dayOf(now.getTime());
  if (now.getHours() < HOUR || D.busy || D.last === today) return;
  D.busy = true;
  try {
    const text = await readTextFile(file()).catch(() => null);
    let o = {};
    try { o = text ? JSON.parse(text.replace(/^﻿/, "")) ?? {} : {}; } catch {}
    if (o.day === today) { D.last = today; return; }
    // Claim the day first (the snapshot check fails if another window wrote it in between).
    try { await writeTextFile(file(), JSON.stringify({ day: today, at: now.toISOString(), state: "running" }), text ?? null); } catch { return; }
    D.last = today;
    const r = await hp(["report", "daily"], { all: true }, 180000);
    const cur = await readTextFile(file()).catch(() => null);
    await writeTextFile(file(), JSON.stringify({ day: today, at: now.toISOString(), ok: r.ok, out: (r.ok ? r.out : r.err).slice(0, 2000) }, null, 1), cur ?? null).catch(() => {});
  } catch {} finally { D.busy = false; }
}

export function startDailyReport(cx) {
  const alive = claimJob("daily-report");
  const tick = (cx) => { if (alive()) cx.spawn(async () => { await maybeRun(); }); };
  cx.timer.after(45000, tick);
  repeat(cx, 10 * 60 * 1000, tick, alive);
}
