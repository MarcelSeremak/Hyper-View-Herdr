// Task workspace in the right panel (where the chat is), Linear-style: the board stays visible.
// One task = one workspace (Conductor / Codex app): Overview, Chat with the task's agent, Changes (the task
// worktree's diff with inline comments + MR/PR review), Terminal (the agent's terminal), and Merge / Archive.
// Open with openTaskPanel(slug, id[, tab]) from anywhere; Chat renders taskPanel() while shared("mp.taskPanel") is set.
import { T } from "./tokens.js";
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, Popover, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, run, shared, setShared } from "herdr";
import {
  hp, toast, demo, icon, iconEl, iconButton, button, meter, agentAvatar, tile, liveAgent, arr, fmtDate, ago, tabsBar,
  showCenter, startAgent, statusColor, STATUS_EN, TASK_EN, TASK_COLOR, PRIO, OK, BAD, INFO, WARN, scrollY, clear, popFocus,
} from "./lib.js";
import { openForm } from "./form.js";
import { isReviewable, reviewButton, reviewPanel, worktreeDiff, wtLoad, wtState } from "./review.js";
import { RIGHT, isCollapsed } from "./toolbar.js";
import { relTime, relShort, skeleton } from "./ide.js";

const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const VERB = { backlog: "backlog", todo: "todo", doing: "start", review: "review", blocked: "block", done: "done" };
const KIND = { commit: ["Commit", null], mr: ["MR", WARN], pr: ["PR", INFO] }; // null: the theme's muted text
const TABS = ["overview", "chat", "changes", "terminal"];

export function openTaskPanel(slug, id, tab) {
  if (!slug || id == null) return;
  setShared("mp.taskPanel", { slug, id, at: Date.now(), ...(TABS.includes(tab) ? { tab } : {}) });
  if (isCollapsed(RIGHT)) { run("layout.resize", { id: RIGHT.id, px: RIGHT.open }); setShared(RIGHT.key, false); }
}
export const closeTaskPanel = () => setShared("mp.taskPanel", null);
export const taskPanelOpen = (slug, id) => { const tp = shared("mp.taskPanel"); return Boolean(tp) && tp.slug === slug && String(tp.id) === String(id); };

export function openUrl(url) {
  exec("explorer.exe", [url]).catch(() => exec("open", [url]).catch(() => exec("xdg-open", [url]).catch(() => toast("Could not open the link", url, "error"))));
}

// Short reference for a link: commit hash (7), !MR or #PR number.
function linkRef(l) {
  const u = String(l.url ?? "");
  let m;
  if ((m = u.match(/\/commits?\/([0-9a-f]{7,40})/i))) return m[1].slice(0, 7);
  if ((m = u.match(/\/merge_requests\/(\d+)/))) return `!${m[1]}`;
  if ((m = u.match(/\/pull\/(\d+)/))) return `#${m[1]}`;
  return "";
}
const who = (by) => (by === "ty" ? "You" : by || "—");

// The composer of the Chat tab: one input, created on first use (never during render), bound once.
function composer(host) {
  if (!host.tpInput) {
    host.tpInput = InputState.new({ placeholder: "Message the agent about this task…" });
    host.tpInput.on("submit", (_e, cx) => sendChat(host, cx));
  }
  return host.tpInput;
}
function sendChat(host, cx) {
  const c = host.tpCtx, text = host.tpInput?.value().trim();
  if (!c || !text || host.tpSending) return;
  const { p, x } = c, to = x.agent || "all";
  host.tpSending = true;
  cx.spawn(async (cx) => {
    if (demo()) toast(`Sent to ${x.agent || "the team"}`, "Demo mode: nothing was sent.", "success");
    else {
      const r = await hp(["say", text], { p: p.slug, as: "ty", to, task: String(x.id) });
      if (!r.ok) { host.tpSending = false; toast("Message not sent", r.err, "error"); cx.notify(); return; }
    }
    (host.tpLocal ??= {})[`${p.slug}/${x.id}`] = [...(host.tpLocal[`${p.slug}/${x.id}`] ?? []), { ts: new Date().toISOString(), from: "ty", to, text, type: "message", task: x.id, local: true }];
    host.tpSending = false;
    host.tpInput.set_value("");
    host.tpScroll?.scroll_to_item(1e6);
    if (!demo()) host.reload(cx);
    cx.notify();
  });
}

// host: the Chat view (keeps tpProject, tpEvents and the panel's UI state).
export function taskPanel(host, t, tp) {
  const p = host.tpProject;
  const x = p && p.slug === tp.slug ? p.tasks.find((y) => String(y.id) === String(tp.id)) : null;
  // Esc anywhere in the panel (no dropdown open) goes back to the chat.
  const shell = (body) => v_flex().id("mp-chat").size_full().bg(t.surface).rounded(T.r.dialog).border_1().border_color(t.border).overflow_hidden().text_color(t.foreground)
    .on_key_down((e, cx) => { if (e.key === "escape" && !host.tpMenu) { closeTaskPanel(); cx.stop_propagation(); } })
    .child(body);
  const top = (extra) => h_flex().flex_none().h(T.h.header).px(8).gap(4).items_center().border_b_1().border_color(t.border)
    .child(iconButton(t, "mp-tp-back", "chevron-left", () => closeTaskPanel(), "Back to chat"))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.dim).child(x ? `${p.name} · #${x.id}` : "Task"))
    .when(Boolean(extra), (el) => el.child(extra))
    .child(iconButton(t, "mp-tp-close", "x", () => closeTaskPanel(), "Close"));
  if (!x) {
    return shell(v_flex().size_full().child(top(null))
      .child(p && p.slug === tp.slug ? div().px(12).py(T.sp.lg).text_size(T.text.sm).text_color(t.dim).child("This task no longer exists.") : div().pt(T.sp.md).child(skeleton(t, 5, { avatar: false }))));
  }
  const key = `${p.slug}/${x.id}`;
  host.tpCtx = { p, x };
  // Tab: the last one picked for this task; an open with { tab } (openTaskPanel / previews) wins once.
  host.tpTabs ??= {};
  if (tp.tab && host.tpTabAt !== tp.at) { host.tpTabAt = tp.at; host.tpTabs[key] = tp.tab; }
  const tab = TABS.includes(host.tpTabs[key]) ? host.tpTabs[key] : "overview";
  const w = x.worktree?.branch ? x.worktree : null;
  if (tab === "changes" && w && !wtState(p, x) && demo()) wtLoad(null, p, x); // demo data is synchronous
  const setTab = (k, cx) => {
    host.tpTabs[key] = k;
    if (k === "chat") { composer(host); host.tpScroll ??= ScrollHandle.new(); host.tpScroll.scroll_to_item(1e6); }
    if (k === "changes" && w && !wtState(p, x)) wtLoad(cx, p, x);
    cx.notify();
  };

  const act = (cx, positional, options, ok) => cx.spawn(async (cx) => {
    const r = await hp(positional, options);
    if (!r.ok) toast("Something went wrong", r.err, "error");
    else if (ok) toast(ok, "", "success");
    host.reload(cx);
  });
  const menuOpen = (k) => host.tpMenu === `${key}:${k}`;
  const setMenu = (k, cx) => { const was = Boolean(host.tpMenu); host.tpMenu = k ? `${key}:${k}` : null; if (!k) host.tpConfirm = null; if (was !== Boolean(k)) popFocus(Boolean(k), "tp-menu"); cx.notify(); };
  // Dropdown: trigger + anchored list (gpui Popover handles outside click and Esc).
  const dropdown = (k, trigger, items, wd = 180, anchor = "top_left") => Popover.new(`mp-tp-dd-${k}`).anchor(anchor)
    .open(menuOpen(k)).on_open_change((o, cx) => setMenu(o ? k : null, cx))
    .trigger(trigger)
    .content(v_flex().w(wd).py(4).mt(4).rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_md()
      .children(items.map((it) => h_flex().id(`mp-tp-${k}-${it.key}`).h(T.h.rowDense).mx(4).px(8).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
        .text_size(T.text.sm).text_color(it.danger ? BAD : t.foreground).hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { if (it.keepOpen) { it.pick(e, cx); return; } setMenu(null, cx); it.pick(e, cx); })
        .child(it.lead ?? div().w(0))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .child(it.on ? iconEl("check", t.accent, 12) : div().w(12)))));
  const chevron = () => iconEl("chevron-down", t.dim, 11);

  // Status: dot + text (the dropdown trigger), priority.
  const sc = TASK_COLOR[x.status];
  const statusDd = dropdown("status",
    h_flex().id("mp-tp-status").h(24).px(6).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().hover((s) => s.bg(t.hover)).text_size(T.text.sm).font_medium()
      .child(div().size(T.dot).rounded_full().bg(sc)).child(TASK_EN[x.status]).child(chevron()),
    COLS.map((s) => ({ key: s, label: TASK_EN[s], on: s === x.status, lead: div().size(T.dot).rounded_full().bg(TASK_COLOR[s]),
      pick: (_e, cx) => {
        if (s === x.status) return;
        const opts = { p: p.slug, as: "ty" };
        if (s === "blocked") opts.reason = "paused by the human";
        x.status = s; // optimistic
        act(cx, ["task", VERB[s], String(x.id)], opts);
      } })));
  const [plabel, pcolor] = PRIO[x.priority] ?? PRIO.normal;
  const prioDd = dropdown("prio",
    h_flex().id("mp-tp-prio").h(24).px(6).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .child(div().size(T.dot).rounded_full().bg(pcolor)).child(div().text_size(T.text.sm).text_color(t.foreground).child(plabel)).child(chevron()),
    Object.keys(PRIO).map((k) => ({ key: k, label: PRIO[k][0], on: k === (x.priority ?? "normal"), lead: div().size(T.dot).rounded_full().bg(PRIO[k][1]),
      pick: (_e, cx) => { if (k === x.priority) return; x.priority = k; act(cx, ["task", "set", String(x.id)], { p: p.slug, as: "ty", priority: k }); } })), 150);
  const moreDd = dropdown("more",
    h_flex().id("mp-tp-more").size(28).rounded(T.r.ctrl).items_center().justify_center().cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Task actions").child(svg(icon("more")).size(T.icon.toolbar)),
    [
      { key: "assign", label: "Reassign…", lead: iconEl("users", t.muted, 13), pick: () => openForm("task-assign", { project: p.slug, task: x.id }) },
      { key: "rm", label: host.tpConfirm === key ? "Click again to delete" : "Delete task", danger: true, lead: iconEl("x", BAD, 13), keepOpen: host.tpConfirm !== key,
        pick: (_e, cx) => {
          if (host.tpConfirm !== key) { host.tpConfirm = key; cx.notify(); return; }
          host.tpConfirm = null; host.tpMenu = null;
          closeTaskPanel();
          act(cx, ["task", "rm", String(x.id)], { p: p.slug }, `Deleted #${x.id}`);
        } },
    ], 200, "top_right");

  const live = x.agent ? liveAgent(p, x.agent) : null;
  const events = taskEvents(host, x, key);
  const msgs = events.filter((e) => e.type === "message").length;
  const ws = wtState(p, x)?.data;
  // Changed files once the worktree is read; before that no number (commit/MR links are not "changes").
  const changes = ws ? arr(ws.files).length : w ? 0 : arr(x.links).length;

  const head = v_flex().flex_none().px(12).pt(8).gap(6)
    .child(div().text_size(T.text.lg).font_semibold().line_height(1.35).whitespace_normal().child(x.title))
    .child(h_flex().gap(6).items_center()
      .child(statusDd)
      .when(x.status === "doing", (el) => el.child(div().text_size(T.text.xs).text_color(t.muted).child(`${x.progress ?? 0}%`)))
      // The agent is listed under Details (no duplicate here), so Merge / Archive keep their room.
      .child(div().flex_1())
      .child(headerActions(host, t, p, x, w, ws, key)))
    .child(h_flex().gap(T.sp.lg).border_b_1().border_color(t.border).children(
      [["overview", "Overview"], ["chat", "Chat", msgs], ["changes", "Changes", changes], ["terminal", "Terminal"]].map(([k, label, n]) =>
        v_flex().id(`mp-tp-tab-${k}`).flex_none().cursor_pointer().on_click((_e, cx) => setTab(k, cx))
          .child(h_flex().h(T.h.rowDense).gap(T.sp.xs).items_center().text_size(T.text.sm).font_medium()
            .text_color(tab === k ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
            .child(label).when(Boolean(n), (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(String(n)))))
          .child(div().h(2).rounded_full().bg(tab === k ? t.accent : clear)))));

  let body;
  if (tab === "chat") body = chatTab(host, t, p, x, events);
  else if (tab === "changes") body = scrollY("mp-tp-scroll-ch", v_flex().flex_1().min_h(0).px(12).pt(12).pb(16).gap(16).child(changesTab(host, t, p, x, w)));
  else if (tab === "terminal") body = scrollY("mp-tp-scroll-term", v_flex().flex_1().min_h(0).px(12).pt(12).pb(16).gap(12).child(terminalTab(host, t, p, x, w, live, events)));
  else body = scrollY("mp-tp-scroll", v_flex().flex_1().min_h(0).px(12).pt(12).pb(16).gap(16).child(overviewTab(host, t, p, x, w, live, prioDd, act)));

  return shell(v_flex().size_full().child(top(moreDd)).child(head).child(body));
}

// Merge (task branch → default branch, --no-ff, hp worktree merge) and Archive (prune the worktree, mark done).
function headerActions(host, t, p, x, w, ws, key) {
  const liveWt = Boolean(w) && !w.pruned && Boolean(w.path);
  const sure = (k) => host.tpSure === `${key}:${k}`;
  const arm = (k, cx) => { host.tpSure = `${key}:${k}`; cx.notify(); cx.timer.after(3000, (cx) => { if (host.tpSure === `${key}:${k}`) { host.tpSure = null; cx.notify(); } }); };
  const run2 = (cx, steps, done) => cx.spawn(async (cx) => {
    host.tpBusy = key; cx.notify();
    for (const [args, opts] of steps) {
      const r = await hp(args, { p: p.slug, as: "ty", ...opts }, 90000);
      if (!r.ok) { host.tpBusy = null; toast("Refused", r.err, "error"); cx.notify(); host.reload(cx); return; }
      if (args[1] === "merge") toast("Merged", r.out.replace(/^ok:\s*/, ""), "success");
    }
    host.tpBusy = null;
    if (done) toast(done, "", "success");
    host.reload(cx);
    if (w && wtState(p, x)) wtLoad(cx, p, x);
    cx.notify();
  });
  const busy = host.tpBusy === key;
  const el = h_flex().flex_none().gap(4).items_center();

  // Merge: a local worktree whose branch is ready (task in Review/Done, committed, ahead of the default branch).
  // The human merges here; agents merge themselves only when their risk level allows (hp enforces it).
  let mergeEl = null;
  if (w?.merged) mergeEl = h_flex().id("mp-tp-merged").h(24).px(6).gap(6).items_center().text_size(T.text.sm).text_color(OK)
    .tooltip(`${w.branch} merged ${fmtDate(w.merged)}${w.merge_sha ? ` (${w.merge_sha})` : ""}`).child(div().size(T.dot).rounded_full().bg(OK)).child("Merged");
  else if (liveWt && !w.machine) {
    const why = !(x.status === "review" || x.status === "done") ? "Merge when the task is in Review or Done"
      : ws && ws.dirty > 0 ? `${ws.dirty} uncommitted change(s) in the worktree: the agent should commit first`
      : ws && !ws.ahead ? "Nothing to merge: the branch has no new commits" : "";
    mergeEl = h_flex().id("mp-tp-merge").h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).cursor_pointer()
      .border_1().border_color(why ? t.border : sure("merge") ? OK : t.border).bg(sure("merge") ? `${OK}22` : t.raised)
      .text_size(T.text.sm).font_medium().text_color(why ? t.dim : sure("merge") ? OK : t.foreground).hover((s) => s.bg(t.hover))
      .tooltip(why || `Merge ${w.branch} into the default branch (--no-ff, local). Refused on conflicts. You merge as the human; agents need their risk level.`)
      .on_click((_e, cx) => {
        if (busy) return;
        if (why) { toast("Not ready to merge", why, "warning"); return; }
        if (!sure("merge")) { arm("merge", cx); return; }
        host.tpSure = null;
        if (demo()) { w.merged = new Date().toISOString(); w.merge_sha = "a1b2c3d"; toast("Merged", `${w.branch} into main. Demo mode: nothing was merged.`, "success"); cx.notify(); return; }
        run2(cx, [[["worktree", "merge", String(x.id)], {}]]);
      })
      .child(iconEl("git-merge", why ? t.dim : sure("merge") ? OK : t.muted, 12))
      .child(busy ? "Working…" : sure("merge") ? "Confirm merge" : "Merge");
  }
  // Archive: shown until the task is done with no live worktree.
  const archEl = x.status === "done" && !liveWt ? null : h_flex().id("mp-tp-archive").h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).cursor_pointer()
    .text_size(T.text.sm).font_medium().text_color(sure("arch") ? BAD : t.muted).bg(sure("arch") ? `${BAD}22` : clear).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(liveWt ? "Remove the worktree folder (the branch stays) and mark the task done" : "Mark the task done")
    .on_click((_e, cx) => {
      if (busy) return;
      if (!sure("arch")) { arm("arch", cx); return; }
      host.tpSure = null;
      if (demo()) {
        if (liveWt) w.pruned = new Date().toISOString();
        x.status = "done"; x.progress = 100;
        toast(`Archived #${x.id}`, "Demo mode: nothing was changed.", "success"); cx.notify(); return;
      }
      const steps = [];
      if (liveWt) steps.push([["worktree", "prune", String(x.id)], {}]);
      if (x.status !== "done") steps.push([["task", "done", String(x.id)], { note: "archived" }]);
      run2(cx, steps, `Archived #${x.id}`);
    })
    .child(iconEl("box", sure("arch") ? BAD : t.muted, 12))
    .child(sure("arch") ? "Confirm" : "Archive");
  return el.when(Boolean(mergeEl), (e) => e.child(mergeEl)).when(Boolean(archEl), (e) => e.child(archEl));
}

// ------------------------------------------------------------ Overview
function overviewTab(host, t, p, x, w, live, prioDd, act) {
  const row = (label, value) => h_flex().min_h(T.h.rowDense).gap(8).items_center()
    .child(div().w(84).flex_none().text_size(T.text.xs).text_color(t.muted).child(label))
    .child(div().flex_1().min_w(0).child(value));
  const val = (s, color) => div().px(6).text_size(T.text.sm).text_color(color ?? t.foreground).truncate().child(s);
  const section = (title, right) => h_flex().h(24).gap(8).items_center()
    .child(div().flex_1().text_size(T.text.xs).font_medium().text_color(t.muted).child(title))
    .when(Boolean(right), (el) => el.child(right));
  const links = arr(x.links);
  const chip = (d, y) => {
    const done = y?.status === "done";
    return h_flex().id(`mp-tp-dep-${d}`).h(22).px(6).gap(4).max_w(220).rounded(T.r.ctrl).items_center().cursor_pointer().border_1().border_color(t.border)
      .hover((s) => s.bg(t.hover)).tooltip(y ? `#${d} ${y.title} · ${TASK_EN[y.status] ?? y.status}` : `#${d} (deleted)`).on_click(() => { if (y) openTaskPanel(p.slug, d); })
      .child(div().flex_none().size(T.dot).rounded_full().bg(y ? TASK_COLOR[y.status] ?? t.dim : t.dim))
      .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(done ? t.muted : t.foreground).child(`#${d} ${y ? y.title : "(deleted)"}`));
  };
  const after = arr(x.after);
  const blocks = p.tasks.filter((y) => arr(y.after).some((d) => String(d) === String(x.id)));
  return v_flex().gap(16)
    .when(x.status === "blocked", (el) => el.child(h_flex().gap(8).pl(T.sp.md).py(T.sp.xs).border_l_2().border_color(BAD).items_start()
      .child(iconEl("alert", BAD, 14)).child(div().flex_1().text_size(T.text.sm).text_color(BAD).whitespace_normal().child(x.blocked_reason || "Blocked, no reason given"))))
    .child(descSection(host, t, p, x, section, act))
    .when(x.kind === "epic", (el) => el.child(epicSection(t, p, x, section)))
    // Evidence (hp task review|done --evidence): what the agent ran to verify the work.
    .when(Boolean(x.evidence) || (links.length > 0 && (x.status === "review" || x.status === "done")), (el) => el.child(v_flex().gap(4)
      .child(section("Evidence"))
      .child(h_flex().id("mp-tp-evidence").gap(8).items_start()
        .tooltip(x.evidence ? `${x.evidence_by ?? ""} ${x.evidence_ts ? fmtDate(x.evidence_ts) : ""}`.trim() || "Evidence" : "Commits without evidence: ask the agent what it ran")
        .child(div().flex_none().mt(6).size(T.dot).rounded_full().bg(x.evidence ? OK : WARN))
        .child(div().flex_1().min_w(0).text_size(T.text.sm).line_height(1.45).whitespace_normal().text_color(x.evidence ? t.foreground : t.muted)
          .child(x.evidence ? String(x.evidence) : "None given yet: ask the agent what it ran.")))))
    .child(v_flex()
      .child(section("Details"))
      .child(row(x.kind === "epic" ? "Lead" : "Agent", h_flex().px(6).gap(6).items_center().child(agentAvatar(t, x.agent ?? "?", live, 18)).child(div().min_w(0).truncate().text_size(T.text.sm).child(x.agent ?? "Unassigned"))))
      .when(x.epic != null && x.epic !== "", (el) => el.child(row("Epic", h_flex().py(2).child(chip(x.epic, p.tasks.find((z) => String(z.id) === String(x.epic)))))))
      .child(row("Priority", h_flex().child(prioDd)))
      .child(row("Machine", x.machine ? h_flex().px(6).gap(6).items_center().child(tile(x.machine, { kind: "vm", size: 16 })).child(div().min_w(0).truncate().text_size(T.text.sm).child(x.machine)) : val("—", t.dim)))
      .when(Boolean(w), (el) => el.child(row("Branch", worktreeRow(host, t, p, x, act))))
      .child(row("Progress", h_flex().px(6).gap(8).items_center().child(div().flex_1().child(meter(t, x.progress ?? 0, x.status === "done" ? OK : null, 4))).child(div().w(34).text_size(T.text.xs).text_color(t.muted).text_right().child(`${x.progress ?? 0}%`))))
      .when(Boolean(x.created), (el) => el.child(row("Created", relTime(t, "mp-tp-created", x.created, { size: T.text.sm, color: t.muted, text: fmtDate(x.created) }).px(6))))
      .when(Boolean(x.started), (el) => el.child(row("Started", relTime(t, "mp-tp-started", x.started, { size: T.text.sm, color: t.muted, text: fmtDate(x.started) }).px(6))))
      .when(Boolean(x.completed), (el) => el.child(row("Completed", relTime(t, "mp-tp-completed", x.completed, { size: T.text.sm, color: t.muted, text: fmtDate(x.completed) }).px(6)))))
    .child(v_flex().gap(4)
      .child(section("Dependencies"))
      .when(after.length === 0 && blocks.length === 0, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child("None.")))
      .when(after.length > 0, (el) => el.child(row("Waits for", h_flex().py(2).gap(4).flex_wrap().children(after.map((d) => chip(d, p.tasks.find((z) => String(z.id) === String(d))))))))
      .when(blocks.length > 0, (el) => el.child(row("Blocks", h_flex().py(2).gap(4).flex_wrap().children(blocks.map((y) => chip(y.id, y)))))));
}

// Epic: its tasks (status dot, #id, title, owner) with progress and the plan state; "Add task" for the human.
export const isEpic = (x) => x?.kind === "epic";
export const epicKids = (p, e) => p.tasks.filter((y) => y.epic != null && String(y.epic) === String(e.id));
export function epicPlanLabel(p, e) {
  const kids = epicKids(p, e);
  if (!kids.length) return ["Not planned", null];
  if (e.plan === "pending") return ["Awaits approval", WARN];
  if (e.plan === "revise") return ["Revise plan", BAD];
  return [TASK_EN[e.status] ?? e.status, TASK_COLOR[e.status]];
}
function epicSection(t, p, x, section) {
  const kids = epicKids(p, x);
  const done = kids.filter((y) => y.status === "done").length;
  const [plan, pc] = epicPlanLabel(p, x);
  const ORDER = { doing: 0, review: 1, blocked: 2, todo: 3, backlog: 4, done: 5 };
  const sorted = [...kids].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || Number(a.id) - Number(b.id));
  return v_flex().gap(4)
    .child(section(`Tasks in this epic${kids.length ? ` · ${done}/${kids.length}` : ""}`,
      button(t, "mp-tp-epic-add", "Add task", () => openForm("task-add", { project: p.slug, epic: x.id }), { small: true, ghost: true, iconName: "plus" })))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_none().size(T.dot).rounded_full().bg(pc ?? t.dim))
      .child(div().flex_none().text_size(T.text.xs).text_color(pc ?? t.muted).child(plan))
      .child(div().flex_1().child(meter(t, kids.length ? (100 * done) / kids.length : 0, OK, 3))))
    .when(kids.length === 0, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).whitespace_normal()
      .child(`${x.agent ?? "The lead"} breaks it into tasks (hp epic plan ${x.id}); you approve the plan in the Mailbox.`)))
    .children(sorted.map((y) => h_flex().id(`mp-tp-ek-${y.id}`).h(T.h.rowDense).px(6).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => openTaskPanel(p.slug, y.id)).tooltip(`${TASK_EN[y.status] ?? y.status}${arr(y.after).length ? " · after " + arr(y.after).map((d) => "#" + d).join(", ") : ""}`)
      .child(div().flex_none().size(T.dot).rounded_full().bg(TASK_COLOR[y.status] ?? t.dim))
      .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`#${y.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(y.status === "done" ? t.muted : t.foreground).child(y.title))
      .child(agentAvatar(t, y.agent ?? "?", null, 18))));
}

// Description: always visible, editable in place.
function descSection(host, t, p, x, section, act) {
  const key = `${p.slug}/${x.id}`;
  const editing = host.descEdit === key;
  const save = (_e, cx) => {
    const text = host.descState.value().trim();
    host.descEdit = null;
    x.desc = text;
    act(cx, ["task", "set", String(x.id)], { p: p.slug, as: "ty", desc: text });
    cx.notify();
  };
  const right = editing
    ? h_flex().gap(6).child(button(t, "mp-tp-dcancel", "Cancel", (_e, cx) => { host.descEdit = null; cx.notify(); }, { small: true, ghost: true }))
      .child(button(t, "mp-tp-dsave", "Save", save, { small: true, primary: true }))
    : button(t, "mp-tp-dedit", x.desc ? "Edit" : "Add", (_e, cx) => {
      host.descState = TextareaState.new({ value: x.desc ?? "", placeholder: "What needs to be done, and how to know it is done", rows: 5 });
      host.descEdit = key;
      host.descState.focus?.();
      cx.notify();
    }, { small: true, ghost: true });
  return v_flex().gap(4)
    .child(section("Description", right))
    .when(editing, (el) => el.child(Textarea.new(host.descState).w_full().min_h(110).p(8).rounded(T.r.panel).border_1().border_color(t.accent)
      .bg(t.background).text_size(T.text.sm).text_color(t.foreground)))
    .when(!editing, (el) => el.child(div().text_size(T.text.sm).line_height(1.55).whitespace_normal()
      .text_color(x.desc ? t.foreground : t.dim).child(x.desc || "No description.")));
}

// ------------------------------------------------------------ Chat
// Everything about the task, oldest first: messages (hp say --task), task events, history, notes.
function taskEvents(host, x, key) {
  const items = [];
  const hist = arr(x.history);
  for (const h of hist) items.push({ ts: h.ts, from: h.by, text: h.text, type: "history" });
  for (const n of arr(x.notes)) if (!hist.some((h) => String(h.text).includes(n.text))) items.push({ ts: n.ts, from: n.by, text: n.text, type: "note" });
  const near = (a, b) => Math.abs(new Date(a) - new Date(b)) < 10000;
  const evs = [...(host.tpEvents ?? []), ...(host.tpLocal?.[key] ?? [])];
  for (const e of evs) {
    if (String(e.task) !== String(x.id)) continue;
    if (e.local && (host.tpEvents ?? []).some((y) => y.from === "ty" && y.text === e.text)) continue; // the real one arrived
    if (e.type === "task" && hist.some((h) => h.by === e.from && near(h.ts, e.ts))) continue; // already in history
    items.push({ ts: e.ts, from: e.from, to: e.to, text: e.text, type: e.type === "message" ? "message" : e.type === "tool" ? "tool" : "history" });
  }
  items.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  return items;
}

function chatTab(host, t, p, x, items) {
  const LIMIT = 40;
  const all = host.tpAll === `${x.id}`;
  const shown = all ? items : items.slice(-LIMIT);
  // Same log style as the team chat: no bubbles, "name → to · time" over the text, events as one dim line.
  const msgRow = (it, i) => {
    const mine = it.from === "ty";
    const prev = shown[i - 1];
    const grouped = prev && prev.type === "message" && prev.from === it.from && new Date(it.ts) - new Date(prev.ts) < 5 * 60000;
    return h_flex().id(`mp-tp-ev-${i}`).pt(grouped ? 0 : T.sp.md).gap(T.sp.md).items_start()
      .child(grouped ? div().w(20).flex_none() : mine
        ? h_flex().flex_none().size(20).rounded_full().bg(t.accent).items_center().justify_center().text_size(T.text.xs).text_color(t.accent_foreground).child("Y")
        : div().flex_none().child(agentAvatar(t, it.from ?? "?", liveAgent(p, it.from), 20)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .when(!grouped, (el) => el.child(h_flex().gap(6).items_center()
          .child(div().text_size(T.text.sm).font_semibold().child(who(it.from)))
          .when(Boolean(it.to) && it.to !== "all", (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(`→ ${it.to === "ty" ? "you" : it.to}`)))
          .child(relTime(t, `mp-tp-ev-ts-${i}`, it.ts))))
        .child(div().text_size(T.text.sm).line_height(`${T.lh.base}px`).whitespace_normal().text_color(t.foreground).child(it.text)));
  };
  const sysRow = (it, i) => h_flex().id(`mp-tp-ev-${i}`).min_h(24).gap(T.sp.md).items_center()
    .child(h_flex().w(16).flex_none().justify_center().child(iconEl(it.type === "tool" ? "terminal" : it.type === "note" ? "paperclip" : "check", t.dim, 11)))
    .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(it.text))
    .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(who(it.from)))
    .child(relTime(t, `mp-tp-ev-ts-${i}`, it.ts));
  const feed = v_flex().flex_1().min_h(0).px(12).pt(8).pb(8).gap(4)
    .when(Boolean(host.tpScroll), (el) => el.track_scroll(host.tpScroll))
    .when(items.length > shown.length, (el) => el.child(h_flex().id("mp-tp-older").h(24).items_center().cursor_pointer().text_size(T.text.xs).text_color(t.accent)
      .on_click((_e, cx) => { host.tpAll = `${x.id}`; cx.notify(); }).child(`Show ${items.length - shown.length} older`)))
    .when(items.length === 0, (el) => el.child(div().py(T.sp.md).text_size(T.text.sm).text_color(t.dim).child("No conversation about this task yet.")))
    .children(shown.map((it, i) => (it.type === "message" ? msgRow(it, i) : sysRow(it, i))));
  const to = x.agent || "the team";
  const inputEl = host.tpInput
    ? h_flex().flex_1().min_w(0).h(T.h.inputLg).px(8).gap(4).items_center().rounded(T.r.ctrl).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(host.tpInput).flex_1().h(28).text_size(T.text.sm).text_color(t.foreground))
      .child(iconButton(t, "mp-tp-send", "send", (_e, cx) => sendChat(host, cx), `Send to ${to} (Enter)`, { size: 24, color: t.accent }))
    : h_flex().id("mp-tp-compose").flex_1().min_w(0).h(T.h.inputLg).px(8).items_center().rounded(T.r.ctrl).border_1().border_color(t.input).bg(t.background).cursor_pointer()
      .text_size(T.text.sm).text_color(t.dim)
      .on_click((_e, cx) => { composer(host).focus(); cx.notify(); })
      .child("Message the agent about this task…");
  return v_flex().flex_1().min_h(0)
    .child(scrollY("mp-tp-chat-scroll", feed))
    .child(v_flex().flex_none().px(12).pt(8).pb(12).gap(4).border_t_1().border_color(t.border)
      .child(h_flex().gap(6).items_center().child(inputEl))
      .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(`To ${to} · linked to #${x.id}`)));
}

// ------------------------------------------------------------ Changes
function changesTab(host, t, p, x, w) {
  const links = arr(x.links);
  const section = (title, n) => h_flex().h(24).gap(6).items_center().child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(title))
    .when(Boolean(n), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(String(n))));
  return v_flex().gap(16)
    .child(v_flex().gap(6)
      .child(section("Worktree"))
      .when(!w, (el) => el.child(div().text_size(T.text.xs).line_height(1.45).text_color(t.dim).whitespace_normal()
        .child(`No worktree. An agent gets one with hp task start ${x.id} --source <name>: its own branch and folder.`)))
      .when(Boolean(w) && !wtState(p, x), (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(t.muted).child(w.branch))
        .child(button(t, "mp-tp-wt-load", "Show diff", (_e, cx) => { wtLoad(cx, p, x); cx.notify(); }, { small: true }))))
      .when(Boolean(w) && Boolean(wtState(p, x)), (el) => el.child(worktreeDiff(host, t, p, x))))
    .child(v_flex().gap(4)
      .child(section("Commits & merge requests", links.length))
      .when(links.length === 0, (el) => el.child(div().text_size(T.text.xs).line_height(1.45).text_color(t.dim).whitespace_normal()
        .child("None yet. Agents add them with hp task link.")))
      .children(links.slice().reverse().map((l, i) => {
        const [klabel, kcolor] = KIND[l.kind] ?? KIND.commit;
        const ref = linkRef(l);
        const rv = isReviewable(l) ? reviewPanel(host, t, p, x, l, i) : null;
        const linkRow = h_flex().id(`mp-tp-link-${i}`).min_h(T.h.row).px(6).py(4).gap(8).items_center().rounded(T.r.ctrl).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(l.url).on_click(() => openUrl(l.url))
          .child(div().flex_none().w(44).text_size(T.text.xs).font_medium().text_color(kcolor ?? t.muted).child(klabel))
          .child(v_flex().flex_1().min_w(0)
            .child(div().min_w(0).truncate().text_size(T.text.sm).child(l.title || l.url))
            .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child([ref, who(l.by), l.ts ? ago(l.ts) : ""].filter(Boolean).join(" · "))))
          .when(isReviewable(l), (el) => el.child(reviewButton(t, p, x, l, i)))
          .child(iconEl("external", t.dim, 11));
        return rv ? v_flex().id(`mp-tp-linkw-${i}`).gap(4).child(linkRow).child(rv) : linkRow;
      })));
}

// ------------------------------------------------------------ Terminal
// The agent runs in a Herdr terminal; terminals live in the center stack, so this tab jumps there
// (embedding a second view of the same terminal in the panel is not supported by the layout).
function terminalTab(host, t, p, x, w, live, events) {
  const agent = x.agent ? p.agents?.find((a) => a.name === x.agent) : null;
  const st = live?.status;
  const tools = (host.tpEvents ?? []).filter((e) => e.type === "tool" && e.from === x.agent && (e.task == null || String(e.task) === String(x.id))).slice(-8);
  const liveWt = Boolean(w) && !w.pruned && Boolean(w.path);
  return v_flex().gap(12)
    .child(h_flex().h(T.h.rowTall).gap(8).items_center()
      .child(agentAvatar(t, x.agent ?? "?", live, 24))
      .child(v_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(T.text.sm).font_medium().child(x.agent ?? "Unassigned"))
        .child(h_flex().gap(6).items_center().text_size(T.text.xs).text_color(statusColor(t, st))
          .child(div().size(T.dot).rounded_full().bg(statusColor(t, st))).child(st ? STATUS_EN[st] ?? st : "Not running")))
      .when(Boolean(live), (el) => el.child(button(t, "mp-tp-term-open", "Open agent terminal", () => { run("agent.focus", { terminal: live.address }); showCenter("mp-terms"); }, { small: true, primary: true, iconName: "terminal" })))
      .when(!live && Boolean(agent), (el) => el.child(button(t, "mp-tp-term-start", "Start agent", () => {
        startAgent(p, agent, `Continue task #${x.id}: ${x.title}`);
        toast(`Starting ${agent.name}`, `On task #${x.id}`, "info");
      }, { small: true, iconName: "play" }))))
    .when(!x.agent, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child("Assign an agent to work on this task (… → Reassign).")))
    .when(Boolean(w), (el) => el.child(h_flex().min_h(T.h.rowDense).gap(6).items_center()
      .child(iconEl("git-branch", t.muted, 12))
      .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(liveWt ? t.foreground : t.dim)
        .child(liveWt ? `${w.machine ? `${w.machine}:` : ""}${w.path}` : `${w.branch} (worktree removed)`))
      .when(liveWt && !w.machine, (e) => e.child(button(t, "mp-tp-term-folder", "Open folder", () => {
        exec("explorer.exe", [String(w.path).replace(/\//g, "\\")]).catch(() => toast("Could not open the folder", w.path, "error"));
      }, { small: true, ghost: true })))))
    .child(v_flex().gap(4)
      .child(h_flex().h(24).items_center().child(div().flex_1().text_size(T.text.xs).font_medium().text_color(t.muted).child("Recent commands")))
      .when(tools.length === 0, (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child("None logged yet (hp ssh / hp log).")))
      .children(tools.map((e, i) => h_flex().id(`mp-tp-tool-${i}`).h(T.h.rowDense - 4).gap(8).items_center().tooltip(e.text)
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child("$"))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.xs).text_color(t.foreground).child(e.text))
        .child(relTime(t, `mp-tp-tool-ts-${i}`, e.ts)))));
}

// Task worktree (hp task start --source): branch, Open folder, Prune (the branch stays).
function worktreeRow(host, t, p, x, act) {
  const w = x.worktree, live = !w.pruned && Boolean(w.path);
  const where = w.machine ? `${w.machine}:${w.path}` : w.path;
  const sure = host.wtConfirm === `${p.slug}/${x.id}`;
  return h_flex().px(6).gap(6).items_center().min_w(0)
    .child(iconEl("git-branch", t.muted, 12))
    .child(div().id("mp-tp-wt").flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(live ? t.foreground : t.muted)
      .tooltip(live ? `${w.source} · worktree ${where}` : `${w.source} · worktree removed, branch kept`).child(w.branch))
    .when(live && !w.machine, (el) => el.child(iconButton(t, "mp-tp-wt-open", "external", () => {
      exec("explorer.exe", [String(w.path).replace(/\//g, "\\")]).catch(() => toast("Could not open the folder", w.path, "error"));
    }, "Open folder", { size: 24 })))
    .when(live, (el) => el.child(iconButton(t, sure ? "mp-tp-wt-prune-sure" : "mp-tp-wt-prune", "x", (_e, cx) => {
      if (!sure) { host.wtConfirm = `${p.slug}/${x.id}`; cx.notify(); cx.timer.after(3000, (cx) => { host.wtConfirm = null; cx.notify(); }); return; }
      host.wtConfirm = null;
      if (demo()) { w.pruned = new Date().toISOString(); toast("Worktree removed (branch kept)", "Demo mode: nothing was changed.", "success"); cx.notify(); return; }
      act(cx, ["worktree", "prune", String(x.id)], { p: p.slug, as: "ty" }, "Worktree removed (branch kept)");
    }, sure ? "Click again: remove the worktree folder (the branch stays)" : "Prune worktree", { size: 24, color: sure ? BAD : undefined })));
}
