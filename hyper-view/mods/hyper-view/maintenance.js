// Housekeeping: keeps ~/.herdr and the app's own leftovers bounded.
//  - `hp maintain --json` at start (after 25 s) and every 6 h: old events -> gzip archive, feed and
//    task history caps, old done tasks -> tasks-archive.jsonl, secret-use log cap, trash > 30 days,
//    temp leftovers, old nvim undo files (details in hp.ps1, "maintenance"). Result: shared("mp.storage").
//  - once per app start: finished background terminals the app made (vm-*, ed-*, login-*, vmkey-*)
//    are removed from herdr-core, and chart files of earlier runs are deleted from .gen/.
// Runs in demo mode too: it only touches real files, never the demo data.
import { hc, setShared } from "herdr";
import { hp, parseJson, claimJob, repeat } from "./lib.js";
import { sweepGen } from "./charts.js";

const EVERY = 6 * 60 * 60 * 1000;
const OURS = /^(vm|ed|login|vmkey)-/;
let started = false;

async function sweepTerminals() {
  const r = await hc(["ls", "--all", "--json"]).catch(() => null);
  const list = parseJson(r?.stdout ?? "")?.terminals ?? [];
  let n = 0;
  for (const t of list) {
    if (!t.name || !OURS.test(t.name) || t.state === "live") continue;
    const x = await hc(["rm", t.address]).catch(() => null);
    if (x && x.code === 0) n++;
  }
  return n;
}

async function runOnce(first) {
  const extra = {};
  if (first) {
    extra.terminals = await sweepTerminals().catch(() => 0);
    extra.charts = await sweepGen().catch(() => 0);
  }
  const r = await hp(["maintain"], { json: true }, 180000);
  const res = r.ok ? parseJson(r.out.split("\n").pop()) : null;
  setShared("mp.storage", res ? { ...res, ...extra, ok: true } : { ok: false, err: r.err, at: new Date().toISOString(), ...extra });
}

export function startMaintenance(cx) {
  const alive = claimJob("maintenance"); // a hot reload supersedes the old build's timer
  started = true;
  let first = true, busy = false;
  const tick = (cx) => {
    if (!alive() || busy) return;
    busy = true;
    cx.spawn(async () => { try { await runOnce(first); } catch {} first = false; busy = false; });
  };
  cx.timer.after(25000, (cx) => tick(cx));
  repeat(cx, EVERY, (cx) => tick(cx), alive);
}
