// Entity actions: what you can do with a machine, project, agent, task, secret or loose agent.
// One list, used by the palette's drill-in (→ / Tab on a row, Raycast "Show actions" / Linear Cmd+K on an
// item) and by every list view (→ on the highlighted row opens the palette straight on this list).
// An item: { id, title, icon, sub?, go?, children?: () => Promise<frame>, danger?, on? }.
// A frame: { title, items }. Danger items ask for a second Enter (the palette shows "Press Enter again").
import { setShared, shared, run } from "herdr";
import {
  hp, toast, demo, loadProject, listProjects, loadMachines, loadSecrets, loadLocks, lockOf, liveAgent, selectProject, openVm, showCenter,
  openDashboard, startAgent, installKey, projectSpace, TASK_EN, PRIO, leadOf,
} from "./lib.js";
import { openForm, RISKS, riskOf } from "./form.js";

const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const VERB = { backlog: "backlog", todo: "todo", doing: "start", review: "review", blocked: "block", done: "done" };
const center = () => showCenter("mp-view");

// Runs an hp change (nothing in demo mode) and tells the result.
async function change(args, opts, ok) {
  if (demo()) { toast(ok ?? "Done", "Demo mode: nothing was changed.", "success"); return true; }
  const r = await hp(args, opts);
  if (!r.ok) { toast("Something went wrong", r.err, "error"); return false; }
  if (ok) toast(ok, "", "success");
  return true;
}

// Opens the chat composer of a project; with a name: filter to that agent and prefill "@name ".
export function chatWith(slug, name) {
  // Stay on the project's page you are on (an agent page keeps its agent).
  if (!(shared("mp.view")?.kind === "project" && shared("mp.view")?.slug === slug)) selectProject(slug);
  center();
  setShared("mp.chatGo", { name: name ?? null, text: name ? `@${name} ` : "", at: Date.now() });
}

// A short label for a ref (breadcrumb).
export function refLabel(ref) {
  if (!ref) return "";
  if (ref.kind === "task") return `#${ref.id}`;
  return ref.label ?? ref.name ?? ref.slug ?? "";
}

export async function actionsFor(ref) {
  try {
    switch (ref?.kind) {
      case "machine": return await machineActions(ref);
      case "project": return await projectActions(ref);
      case "agent": return await agentActions(ref);
      case "task": return await taskActions(ref);
      case "secret": return await secretActions(ref);
      case "loose": return await looseActions(ref);
    }
  } catch (err) { console.warn("actions:", err); }
  return { title: refLabel(ref), items: [] };
}

// ------------------------------------------------------------ machine
async function machineActions({ name }) {
  const m = (await loadMachines()).find((x) => x.name === name) ?? { name };
  await loadLocks().catch(() => {});
  const locked = Boolean(lockOf(name));
  const ed = () => import("./editor.js");
  return {
    title: name,
    items: [
      { id: "open", title: "Open", icon: "server", go: () => { openVm(name); center(); } },
      { id: "editor", title: "Editor", icon: "file-text", go: () => ed().then((e) => e.openEditor(name)) },
      { id: "term", title: "Terminal under editor", icon: "terminal", sub: "toggle", go: () => ed().then(async (e) => { await e.openEditor(name); await e.toggleTerminal(name); }) },
      { id: "access", title: "Access", icon: "shield", go: () => { openVm(name, "access"); center(); } },
      { id: "edit", title: "Edit", icon: "settings", go: () => openForm("vm-edit", { machine: m.name, host: m.host, user: m.user, port: String(m.port ?? 22), desc: m.desc ?? "" }) },
      { id: "key", title: "Install SSH key", icon: "key", go: () => installKey(name) },
      locked
        ? { id: "unlock", title: "Unlock", icon: "lock", sub: lockOf(name)?.owner ? `locked by ${lockOf(name).owner}` : "", go: async () => { await change(["unlock", name], { as: "ty" }, `Unlocked ${name}`); loadLocks().catch(() => {}); } }
        : { id: "lock", title: "Lock", icon: "lock", sub: "60 min, for everyone", go: async () => { await change(["lock", name, "Locked by the human"], { as: "ty", ttl: 60 }, `Locked ${name}`); loadLocks().catch(() => {}); } },
      { id: "rm", title: "Delete", icon: "x", danger: true, sub: "the server itself is untouched", go: async () => {
        if (!(await change(["vm", "rm", name], {}, `Deleted ${name}`))) return;
        openDashboard(); center();
      } },
    ],
  };
}

// ------------------------------------------------------------ project
async function projectActions({ slug }) {
  const p = await loadProject(slug);
  if (!p) return { title: slug, items: [] };
  if (p.loose) return looseActions({ slug });
  const paused = p.status === "paused";
  const tab = (k, label, icon) => ({ id: `tab-${k}`, title: `Open ${label}`, icon, go: () => { selectProject(slug, k); center(); } });
  return {
    title: p.name,
    items: [
      tab("overview", "overview", "layout"), tab("agents", "agents", "bot"), tab("tasks", "tasks", "check-square"), tab("epics", "epics", "layers"), tab("machines", "machines", "server"), tab("activity", "activity", "activity"),
      { id: "task", title: "New task", icon: "plus", go: () => openForm("task-add", { project: slug }) },
      { id: "agent", title: "Add agent", icon: "bot", go: () => openForm("agent-new", { project: slug }) },
      { id: "chat", title: "Chat with team", icon: "send", go: () => chatWith(slug) },
      { id: "pause", title: paused ? "Resume project" : "Pause project", icon: paused ? "play" : "pause", go: async () => {
        if (!(await change(["project", "set"], { p: slug, status: paused ? "active" : "paused" }, paused ? `Resumed ${p.name}` : `Paused ${p.name}`)) || demo()) return;
        await hp(["say", paused ? "Project resumed. Continue your tasks." : "Project paused by the human. Finish your current step and wait (hp wait)."], { p: slug, as: "ty" });
      } },
      { id: "creds", title: "Project access", icon: "key", sub: "tokens shared with it", go: () => openForm("project-secrets", { project: slug }) },
      { id: "rename", title: "Rename", icon: "pencil", sub: "and description", go: () => openForm("project-edit", { project: slug, name: p.name, desc: p.desc ?? "" }) },
      { id: "rm", title: "Delete", icon: "x", danger: true, sub: "moved to ~/.herdr/trash", go: async () => {
        if (!(await change(["project", "rm"], { p: slug, confirm: slug }, `Deleted ${p.name}`)) || demo()) return;
        const sp = projectSpace({ name: p.name });
        if (sp) run("space.close", { id: sp.id, confirmed: true });
        const rest = (await listProjects()).filter((x) => x.slug !== slug && !x.loose);
        selectProject(rest[0]?.slug ?? null, "overview");
      } },
    ],
  };
}

// ------------------------------------------------------------ agent
async function agentActions({ slug, name }) {
  const p = await loadProject(slug);
  const a = p?.agents?.find((x) => x.name === name);
  if (!p || !a) return { title: name, items: [] };
  if (p.loose) return looseActions({ slug });
  const live = liveAgent(p, name);
  const risk = riskOf(a);
  return {
    title: name,
    items: [
      { id: "open", title: "Open", icon: "bot", go: () => { selectProject(slug, "agents"); setShared("mp.openAgent", { slug, name, at: Date.now() }); center(); } },
      { id: "chat", title: "Chat with it", icon: "send", sub: `@${name}`, go: () => chatWith(slug, name) },
      { id: "task", title: "Assign task", icon: "plus", go: () => openForm("task-add", { project: slug, for: name }) },
      live
        ? { id: "stop", title: "Stop", icon: "square", danger: true, go: () => import("./supervisor.js").then((m) => { m.markManualStop(slug, name); run("terminal.kill", { terminal: live.address }); }) }
        : { id: "start", title: "Start", icon: "play", go: () => startAgent(p, a) },
      ...(live ? [{ id: "term", title: "Jump to terminal", icon: "terminal", go: () => { run("agent.focus", { terminal: live.address }); showCenter("mp-terms"); } }] : []),
      { id: "risk", title: "Risk level", icon: "shield", sub: RISKS.find((r) => r[0] === risk)?.[1] ?? risk, children: async () => ({
        title: "Risk level",
        items: RISKS.map(([val, short, full]) => ({ id: val, title: short, sub: full, on: val === risk, icon: "shield",
          go: () => { if (val !== risk) change(["agent", "set", name], { p: slug, risk: val }, `${name}: ${full}`); } })),
      }) },
      // Team lead: answers team messages, gets new epics to plan, "Lead" in the task form. One per project.
      leadOf(p) === name
        ? { id: "lead", title: "Team lead", icon: "users", sub: "this agent", on: true, go: () => toast(`${name} is the team lead`, "Set another agent as lead to change it.", "info") }
        : { id: "lead", title: "Set as lead", icon: "users", sub: `now ${leadOf(p) ?? "none"}`, go: () => change(["agent", "set", name], { p: slug, lead: "on" }, `${name} is now the team lead`) },
      { id: "rm", title: "Remove", icon: "x", danger: true, go: async () => {
        if (live && !demo()) run("terminal.kill", { terminal: live.address });
        await change(["agent", "rm", name], { p: slug }, `Removed ${name}`);
      } },
    ],
  };
}

// ------------------------------------------------------------ task
async function taskActions({ slug, id }) {
  const p = await loadProject(slug);
  const x = p?.tasks?.find((y) => String(y.id) === String(id));
  if (!p || !x) return { title: `#${id}`, items: [] };
  const tp = () => import("./taskpanel.js");
  const w = x.worktree?.branch ? x.worktree : null;
  const liveWt = Boolean(w) && !w.pruned && Boolean(w.path);
  const canMerge = liveWt && !w.machine && !w.merged && (x.status === "review" || x.status === "done");
  return {
    title: `#${x.id} ${x.title}`,
    items: [
      { id: "open", title: "Open", icon: "check-square", go: () => { selectProject(slug, "tasks"); center(); tp().then((m) => m.openTaskPanel(slug, x.id)); } },
      { id: "status", title: "Change status", icon: "activity", sub: TASK_EN[x.status] ?? x.status, children: async () => ({
        title: "Status",
        items: COLS.map((s) => ({ id: s, title: TASK_EN[s], on: s === x.status, icon: "chevron-right",
          go: () => { if (s !== x.status) change(["task", VERB[s], String(x.id)], { p: slug, as: "ty", ...(s === "blocked" ? { reason: "paused by the human" } : {}) }, `#${x.id} → ${TASK_EN[s]}`); } })),
      }) },
      { id: "prio", title: "Priority", icon: "alert", sub: (PRIO[x.priority] ?? PRIO.normal)[0], children: async () => ({
        title: "Priority",
        items: Object.keys(PRIO).map((k) => ({ id: k, title: PRIO[k][0], on: k === (x.priority ?? "normal"), icon: "chevron-right",
          go: () => { if (k !== (x.priority ?? "normal")) change(["task", "set", String(x.id)], { p: slug, as: "ty", priority: k }, `#${x.id}: ${PRIO[k][0]} priority`); } })),
      }) },
      { id: "assign", title: "Reassign", icon: "users", sub: x.agent ?? "unassigned", go: () => openForm("task-assign", { project: slug, task: x.id }) },
      ...(w ? [{ id: "wt", title: "Open worktree", icon: "git-merge", sub: w.branch, go: () => { selectProject(slug, "tasks"); center(); tp().then((m) => m.openTaskPanel(slug, x.id, "changes")); } }] : []),
      ...(canMerge ? [{ id: "merge", title: "Merge", icon: "git-merge", danger: true, sub: `${w.branch} → default branch`, go: () => change(["worktree", "merge", String(x.id)], { p: slug, as: "ty" }, `Merged #${x.id}`) }] : []),
      ...(x.status === "done" && !liveWt ? [] : [{ id: "archive", title: "Archive", icon: "box", danger: true, sub: liveWt ? "remove worktree, mark done" : "mark done", go: async () => {
        if (liveWt && !(await change(["worktree", "prune", String(x.id)], { p: slug, as: "ty" }))) return;
        if (x.status !== "done") await change(["task", "done", String(x.id)], { p: slug, as: "ty", note: "archived" }, `Archived #${x.id}`);
      } }]),
    ],
  };
}

// ------------------------------------------------------------ secret
async function secretActions({ name }) {
  const s = (await loadSecrets()).find((x) => x.name === name);
  if (!s) return { title: name, items: [] };
  return {
    title: name,
    items: [
      { id: "edit", title: "Edit", icon: "settings", go: () => openForm("secret-add", { edit: s }) },
      { id: "share", title: "Share with", icon: "users", sub: s.projects.length ? `${s.projects.length} project${s.projects.length === 1 ? "" : "s"}` : "not shared", children: async () => {
        const fresh = (await loadSecrets()).find((x) => x.name === name) ?? s;
        const projects = await listProjects();
        return {
          title: "Share with",
          items: projects.map((p) => {
            const on = fresh.projects.includes(p.slug);
            const label = p.loose ? p.agents?.[0]?.name ?? p.name : p.name;
            return { id: p.slug, title: label, sub: p.loose ? "loose agent" : "", on, tile: { name: p.name, color: p.color },
              go: () => change(["secret", on ? "unshare" : "share", name], { p: p.slug }, on ? `${name} no longer shared with ${label}` : `${name} shared with ${label}`) };
          }),
        };
      } },
      { id: "copy", title: "Copy name", icon: "copy", go: () => import("./clipboard.js").then(async (m) => { if (await m.copyText(name)) toast("Copied", name, "success"); }) },
      { id: "rm", title: "Remove", icon: "x", danger: true, sub: "revoke everywhere", go: () => change(["secret", "rm", name], {}, `Revoked ${name}`) },
    ],
  };
}

// ------------------------------------------------------------ loose agent
async function looseActions({ slug }) {
  const p = await loadProject(slug);
  if (!p) return { title: slug, items: [] };
  const a = p.agents?.[0] ?? { name: p.name };
  const live = liveAgent(p, a.name);
  return {
    title: a.name,
    items: [
      { id: "chat", title: "Chat", icon: "send", go: () => chatWith(slug) },
      { id: "access", title: "Machine access", icon: "server", go: () => { selectProject(slug, "overview"); center(); } },
      ...(live ? [{ id: "stop", title: "Stop", icon: "square", danger: true, go: () => run("terminal.kill", { terminal: live.address }) }] : []),
      { id: "creds", title: "Project access", icon: "key", sub: "tokens shared with it", go: () => openForm("project-secrets", { project: slug }) },
      { id: "rm", title: "Delete", icon: "x", danger: true, go: async () => {
        if (live && !demo()) run("terminal.kill", { terminal: live.address });
        if (!(await change(["project", "rm"], { p: slug, confirm: slug }, `Deleted ${a.name}`)) || demo()) return;
        const rest = (await listProjects()).filter((x) => !x.loose);
        selectProject(rest[0]?.slug ?? null, "overview");
      } },
    ],
  };
}

// Opens the palette straight on an entity's actions (→ on a row in any list view).
export function openActions(ref) {
  if (!ref) return;
  import("./palette.js").then((m) => m.openPaletteWith({ drill: ref }));
}
