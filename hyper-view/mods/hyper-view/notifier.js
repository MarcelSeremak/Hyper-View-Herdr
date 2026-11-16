// Notifier: tells you (Herdr notification) only about things that need you — a new message or
// question to "ty" (supervisor give-ups arrive this way too) and a task an agent marked Blocked.
// A live agent waiting for input is not repeated here: Herdr notifies about that itself.
// Every 10 s at most one notification ("3 new items need you"); clicking it opens the Mailbox
// (action "hyper-view.mailbox", handled by nextCommand below). Ids seen are kept in memory and
// seeded silently on the first run (and after demo mode), so old items never pop up.
// Off with the bell in the Mailbox (mailbox.json "notify"); nothing in demo mode.
import { notify, nextCommand } from "herdr";
import { demo, openMailbox, showCenter, claimJob, repeat } from "./lib.js";
import { loadMailbox, notifyOn } from "./mailbox.js";

const EVERY = 10000;
let started = false;
let seen = null;   // Set of item ids already known (null = seed on the next run)
let dozing = new Set(); // ids snoozed at the last check: when one comes back it is news again (Linear snooze)

const needsYou = (it) => !it.auto && (it.kind === "msg" || it.kind === "ask" || it.kind === "approval" || (it.kind === "task" && it.status === "blocked"));

export function startNotifier(cx) {
  // One command loop and one check timer per process: an old build's loop would race this one for
  // every command (and run the old palette code); it exits at its next command once superseded.
  const alive = claimJob("notifier");
  started = true;
  let busy = false;
  cx.spawn(async () => {
    for (;;) {
      const c = await nextCommand();
      if (!alive()) return;
      if (c === "mailbox") { openMailbox(); showCenter("mp-view"); }
      // Palette and its actions: "hyper-view.palette" (Ctrl+K), "hyper-view.waiting" (Ctrl+J), …
      else import("./palette.js").then((m) => m.runCommand(c)).catch(() => {});
    }
  });
  repeat(cx, EVERY, (cx) => {
    if (busy) return;
    busy = true;
    cx.spawn(async () => { try { await check(); } catch {} busy = false; });
  }, alive);
}

async function check() {
  if (demo()) { seen = null; return; }
  const { items, done, snooze } = await loadMailbox(); // done also holds snoozed ids
  const fresh = items.filter((it) => needsYou(it) && !done.has(it.id));
  const woke = fresh.filter((it) => dozing.has(it.id));
  dozing = new Set(Object.keys(snooze ?? {}));
  if (!seen) { seen = new Set(items.map((it) => it.id)); return; }
  const news = fresh.filter((it) => !seen.has(it.id) || woke.includes(it));
  items.forEach((it) => seen.add(it.id));
  if (!news.length || !notifyOn()) return;
  const one = news.length === 1 ? news[0] : null;
  const name = (it) => it.proj?.loose ? it.proj.agents?.[0]?.name ?? it.proj.name : it.proj?.name ?? it.slug;
  notify({
    title: one
      ? one.kind === "task" ? `${one.from} is blocked` : one.kind === "ask" ? `${one.from} asks you` : one.kind === "approval" ? `${one.from} needs your approval` : `Message from ${one.from}`
      : `${news.length} new items need you`,
    body: one
      ? `${name(one)}: ${one.text}`.slice(0, 240)
      : [...new Set(news.map(name))].join(", "),
    level: news.some((it) => it.kind !== "msg") ? "warning" : "info",
    timeout: 10000,
    action: { name: "hyper-view.mailbox" },
  });
}
