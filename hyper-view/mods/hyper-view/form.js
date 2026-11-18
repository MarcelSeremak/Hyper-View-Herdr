// Dialogs. hp.ps1 does all writes; passwords and tokens go straight to the
// Windows Credential Manager and never stay in app state.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea, Popover } from "gpui-base";
import { props, theme, openOverlay, closeOverlay, notify, setShared, shared, readTextFile } from "herdr";
import { TEAMS, COMMON_PROMPT, loadCustomTeams, changeCustomTeams } from "./teams.js";
import { IMPORT_PH, IMPORT_EXAMPLE, parseMachines, pickFile, slugify } from "./vmimport.js";
import { copyText, changeClips } from "./clipboard.js";
import { SecretWizard } from "./secretwizard.js";
import { agentChoices, pairsToText, saveSkill, saveServer } from "./kit.js";
import { kbd } from "./ide.js";
import {
  scrollY, MOD, demo, rememberFocus, leadOf, OK, WARN, BAD, hp, hpCmd, installKey, looseSlug, loadSecrets, selectProject, openVm, loadProject, loadMachines, listProjects, startAgent, showCenter, button, toast, iconEl, clear, tile, grid,
} from "./lib.js";

// Dialogs with long lists (machines, tokens, agents): fixed height, the fields scroll, buttons stay put.
const TALL = new Set(["agent-new", "loose-agent", "skill-edit", "mcp-edit"]);
export function openForm(kind, extra = {}) {
  if (!extra?.tour) rememberFocus(`form:${kind}`); // focus goes back to this zone when the dialog closes (lib.js focus manager)
  openOverlay({ mod: MOD, props: { role: "form", kind, ...extra }, kind: "dialog", ...(TALL.has(kind) ? { height: 0.88 } : {}), width: kind === "agent-new" || kind === "loose-agent" || kind === "vm-import" ? 680 : kind === "message" || kind === "snippet" || kind === "secret-add" || kind === "skill-edit" || kind === "mcp-edit" ? 640 : kind === "task-add" ? 520 : 480, modal: true });
}

// Field: { key, label, ph?, value?, type: text|masked|textarea|choice|multi, choices?, optional?, show?(values) }
// No help text under fields: a label on top and a short placeholder inside.

// Agent picker of the task / epic form: [value, label, short label for the closed dropdown].
function forChoices(project, agents) {
  const lead = leadOf(project);
  return [
    ["team", "Any", "Any"],
    ...(lead ? [["@lead", "Lead", "Lead"]] : []),
    ...agents.map(([n]) => [n, n === lead ? `${n} · lead` : n, n]),
  ];
}

function spec(p, data) {
  const machines = data.machines.map((m) => [m.name, m.name]);
  const projMachines = (data.project?.machines ?? []).map((n) => [n, n]);
  const agents = (data.project?.agents ?? p.agents ?? []).map((a) => [a.name, a.name]);
  switch (p.kind) {
    case "project-new": return {
      title: "New Project", submit: "Create", icon: "layout",
      fields: [
        { key: "name", label: "Name", ph: "E-commerce Platform" },
        { key: "desc", label: "Description", type: "textarea", optional: true, ph: "Goal, stack…" },
        { key: "machines", label: "Machines", type: "multi", optional: true, choices: machines, value: [] },
      ],
    };
    case "project-edit": return {
      title: "Edit Project", submit: "Save",
      fields: [
        { key: "name", label: "Name", value: p.name },
        { key: "desc", label: "Description", type: "textarea", optional: true, value: p.desc },
      ],
    };
    case "vm-add": return {
      title: "New Machine", submit: "Add", icon: "server",
      fields: [
        { key: "name", label: "Name", ph: "web-frontend-01" },
        { key: "host", label: "Host", ph: "192.168.1.10" },
        { key: "port", label: "Port", value: "22", join: 96 },
        { key: "user", label: "User", ph: "root" },
        { key: "password", label: "Password", type: "masked" },
        { key: "sudo", label: "Sudo access", type: "switch", value: false },
      ],
    };
    case "vm-import": return {
      title: "Import Machines", submit: "Import", icon: "server",
      fields: [
        { key: "text", label: "Machines", type: "textarea", rows: 7, value: p.text ?? "", ph: IMPORT_PH },
        { key: "preview", label: "Preview", type: "import", optional: true },
      ],
    };
    case "vm-edit": return {
      title: `Edit Machine · ${p.machine}`, submit: "Save",
      fields: [
        { key: "host", label: "Host", value: p.host }, { key: "port", label: "Port", value: p.port, join: 96 },
        { key: "user", label: "User", value: p.user }, { key: "desc", label: "Description", optional: true, value: p.desc },
      ],
    };
    case "vm-sudo": return {
      title: `Sudo · ${p.machine}`, submit: "Save", icon: "shield",
      fields: [
        { key: "user", label: "User", value: p.user ?? "" },
        { key: "password", label: "Password", ph: "Loading…" },
      ],
    };
    case "vm-password": return {
      title: `SSH Password · ${p.machine}`, submit: "Save", icon: "key",
      fields: [{ key: "password", label: "Password", ph: "Loading…" }],
    };
    case "vm-attach": {
      const free = machines.filter(([n]) => !(p.attached ?? []).includes(n));
      return { title: "Attach Machines", submit: "Attach", icon: "server", fields: [{ key: "machines", label: "Machines", type: "multi", choices: free, value: [] }] };
    }
    case "loose-agent": return {
      title: "New Loose Agent", submit: "Create", icon: "bot",
      fields: [
        { key: "app", label: "Engine", type: "choice", value: "claude", choices: [["claude", "Claude Code"], ["codex", "Codex"]], big: true },
        { key: "name", label: "Name", ph: "architect" },
        { key: "role", label: "Role", optional: true, ph: "Helps plan architecture" },
        { key: "access", label: "Machine access", type: "access", optional: true },
        { key: "creds", label: "Tokens shared with this agent", type: "multi", optional: true, value: [], choices: (data.secrets ?? []).map((x) => [x.name, x.name]) },
      ],
    };
    case "project-secrets": return {
      title: "Project Access", submit: "Save", icon: "key",
      fields: [{ key: "creds", label: "Tokens shared with this project", type: "multi", optional: true,
        value: (data.secrets ?? []).filter((x) => (x.projects ?? []).includes(p.project)).map((x) => x.name),
        choices: (data.secrets ?? []).map((x) => [x.name, x.name]) }],
    };
    case "snippet": {
      const e = p.edit;
      return {
        title: e ? "Edit Snippet" : "New Snippet", submit: "Save", icon: "inbox",
        fields: [
          { key: "kind", label: "Type", type: "choice", value: e?.kind ?? "prompt", choices: [["prompt", "Prompt"], ["note", "Note"], ["command", "Command"], ["link", "Link"]] },
          { key: "title", label: "Title", value: e?.title ?? "", ph: "Deploy checklist" },
          { key: "text", label: "Content", type: "textarea", rows: 10, value: e?.text ?? "", ph: "Paste or write anything…" },
        ],
      };
    }
    // Compact layout of its own (Form.taskAdd): title, description, one row of agent/priority/column,
    // the rest under "More options". Opened with { for } (Assign Task) the agent is fixed: a header chip.
    case "task-add": {
      const sources = (data.project?.sources ?? []).map((x) => [x.name, x.name]);
      return {
        title: "New Task", submit: "Create Task", icon: "plus",
        fields: [
          // Task or Epic (a big goal the lead breaks into tasks); opened from an epic ({ epic }) it is always a task of it.
          { key: "kind", label: "Kind", type: "seg", value: p.asEpic ? "epic" : "task", choices: [["task", "Task"], ["epic", "Epic"]] },
          { key: "title", label: "Title", ph: "Deploy API to staging" },
          { key: "desc", label: "Description", type: "textarea", rows: 3, optional: true, ph: "Details, links, what done looks like" },
          // Who: "Any" (--for team: unassigned, the first free agent takes it from hp ready), "Lead (<name>)"
          // (resolved to the lead's name on submit), or one agent (the lead marked). Task → Any, Epic → Lead.
          { key: "for", label: "Agent", type: "choice", value: p.for ?? (p.asEpic ? "@lead" : "team"), choices: forChoices(data.project, agents) },
          { key: "priority", label: "Priority", type: "seg", value: "normal", choices: [["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]] },
          { key: "status", label: "Column", type: "seg", value: "todo", choices: [["backlog", "Backlog"], ["todo", "To Do"]] },
          { key: "machine", label: "Machine", type: "choice", optional: true, value: "", choices: [["", "Any"], ...projMachines] },
          { key: "after", label: "Waits for", optional: true, ph: "#2, #5" },
          { key: "source", label: "Source", type: "choice", optional: true, value: "", choices: [["", "None"], ...sources] },
        ],
      };
    }
    case "task-assign": return {
      title: `Reassign Task #${p.task}`, submit: "Reassign",
      fields: [{ key: "for", label: "Agent", type: "choice", value: agents[0]?.[0] ?? "", choices: agents }],
    };
    case "agent-new": {
      const single = (v) => (v.mode ?? "single") === "single";
      return {
        title: "New Agent", submit: "Launch", icon: "bot", wide: true,
        fields: [
          { key: "mode", label: "Launch", type: "choice", value: "single", choices: [["single", "One agent"], ["team", "A team"]] },
          { key: "app", label: "Engine", type: "choice", value: "claude", choices: [["claude", "Claude Code"], ["codex", "Codex"]], big: true, show: single },
          { key: "name", label: "Name", ph: "deploy-agent", show: single },
          { key: "role", label: "Role", optional: true, ph: "Handles deployments and CI/CD", show: single },
          { key: "team", label: "Team", type: "team", optional: true, show: (v) => !single(v) },
          { key: "access", label: "Machine access", type: "access", optional: true },
          { key: "risk", label: "Risk level", labelFn: (v) => (single(v) ? "Risk level" : "Risk level · every agent"), type: "seg", value: "balanced",
            choices: RISKS.map((r) => [r[0], r[1]]), dots: Object.fromEntries(RISKS.map((r) => [r[0], r[3]])), hint: (v) => RISKS.find((r) => r[0] === v)?.[2] ?? "" },
          { key: "goal", label: "Prompt", type: "textarea", rows: 6, optional: true, ph: "What should the agent (or team) do?" },
        ],
      };
    }
    case "message": return {
      title: p.task ? `Message · #${p.task}` : "Message", submit: "Send", icon: "send",
      fields: [
        { key: "to", label: "To", type: "choice", value: p.to ?? "all", choices: [["all", "Team"], ...agents] },
        { key: "text", label: "Message", type: "textarea", rows: 5 },
      ],
    };
    // Code source (repo) of a project: sources.js / hp source add|set.
    case "source-add":
    case "source-edit": {
      const src = p.source ?? {}, edit = p.kind === "source-edit";
      const remote = (v) => ["github", "gitlab", "bitbucket", "other-remote"].includes(v.kind);
      const locs = src.locations ?? [];
      const vms = locs.filter((l) => l.type === "vm").map((l) => `${l.machine}:${l.path}${l.deployed ? ` deployed${l.service ? " " + l.service : ""}` : ""}`).join("\n");
      return {
        title: edit ? `Edit Source · ${src.name}` : "Add Source", submit: edit ? "Save" : "Add", icon: "git-branch",
        fields: [
          ...(edit ? [] : [{ key: "name", label: "Name", ph: "web-frontend" }]),
          { key: "kind", label: "Where it lives", type: "choice", value: src.kind ?? "github",
            choices: [["github", "GitHub"], ["gitlab", "GitLab"], ["bitbucket", "Bitbucket"], ["other-remote", "Other remote"], ["vm-path", "VM path"], ["local-path", "Local path"]] },
          { key: "url", label: "Remote URL", ph: "https://github.com/org/repo", value: src.url ?? "", show: remote },
          { key: "branch", label: "Default branch", value: src.branch ?? "main" },
          { key: "secret", label: "Token (Tokens & Access)", type: "choice", optional: true, value: src.secret ?? "", show: remote,
            choices: [["", "Auto by host"], ...(data.secrets ?? []).filter((x) => /git|bitbucket|azdo/.test(`${x.provider ?? x.kind}`)).map((x) => [x.name, x.name])] },
          { key: "local", label: "Local folder on this PC", optional: true, ph: "C:\\code\\repo", value: locs.find((l) => l.type === "local")?.path ?? "" },
          { key: "vms", label: "VM paths, one per line: machine:/path [deployed [service]]", type: "textarea", rows: 3, optional: true, value: vms, ph: "web-frontend-01:/srv/app deployed nginx" },
        ],
      };
    }
    // Skills and MCP servers (kit.js): attached to any agent, project or loose.
    case "skill-edit": {
      const e = p.edit;
      return {
        title: e ? `Edit Skill · ${e.name}` : "New Skill", submit: "Save", icon: "puzzle",
        fields: [
          { key: "name", label: "Name", value: e?.name ?? "", ph: "deploy-checklist", optional: true },
          { key: "desc", label: "Description: when should the agent use it?", value: e?.desc ?? "", ph: "Use when deploying to staging or production", optional: true },
          { key: "body", label: "Prompt", type: "textarea", rows: 14, value: e?.body ?? "", ph: "Steps, rules, checklists the agent follows…" },
          { key: "agents", label: "Attached to agents", type: "multi", optional: true, value: e?.agents ?? [], choices: agentChoices(data.projects) },
        ],
      };
    }
    case "mcp-edit": {
      const e = p.edit, x = p.tpl ?? {};
      const stdio = (v) => v.transport !== "http", http = (v) => v.transport === "http";
      return {
        title: e ? `Edit MCP Server · ${e.name}` : x.title && !String(x.id).startsWith("custom") ? `Add ${x.title}` : "New MCP Server", submit: "Save", icon: "plug",
        fields: [
          { key: "name", label: "Name (the agent sees its tools as this)", value: e?.name ?? x.name ?? "", ph: "my-server" },
          { key: "desc", label: "Description", optional: true, value: e?.desc ?? x.desc ?? "", ph: "What it gives the agent" },
          { key: "transport", label: "Type", type: "seg", value: e?.transport ?? x.transport ?? "stdio", choices: [["stdio", "Local program (stdio)"], ["http", "Remote (HTTP)"]] },
          { key: "command", label: "Command", value: e?.command ?? x.command ?? "", ph: "npx", show: stdio },
          { key: "args", label: "Arguments, one per line", type: "textarea", rows: 3, optional: true, value: e ? (e.args ?? []).join("\n") : x.args ?? "", ph: "-y\n@scope/server", show: stdio },
          { key: "env", label: "Environment, KEY=value per line (${secret:NAME} = a token)", type: "textarea", rows: 3, optional: true, value: e ? pairsToText(e.env, "=") : x.env ?? "", ph: "API_KEY=${secret}", show: stdio },
          { key: "cwd", label: "Working folder", optional: true, value: e?.cwd ?? "", ph: "C:\\code\\repo", show: stdio },
          { key: "url", label: "URL", value: e?.url ?? x.url ?? "", ph: "https://example.com/mcp", show: http },
          { key: "headers", label: "Headers, Name: value per line (${secret:NAME} = a token)", type: "textarea", rows: 2, optional: true, value: e ? pairsToText(e.headers, ": ") : x.headers ?? "", ph: "Authorization: Bearer ${secret}", show: http },
          { key: "secret", label: x.secret ? "Token from Tokens & Access (fills ${secret})" : "Token for ${secret} (optional)", type: "choice", optional: true, value: "",
            choices: [["", x.secret === true ? "Pick one" : "None"], ...(data.secrets ?? []).map((y) => [y.name, y.name])] },
          { key: "agents", label: "Attached to agents", type: "multi", optional: true, value: e?.agents ?? [], choices: agentChoices(data.projects) },
        ],
      };
    }
    default: return { title: p.kind, submit: "OK", fields: [] };
  }
}

export class Form {
  init(cx) {
    this.p = props() ?? {};
    // Add/edit secret has its own multi-step wizard (secretwizard.js).
    if (this.p.kind === "secret-add") { this.wiz = new SecretWizard(this.p); this.wiz.init(cx); return; }
    this.data = { machines: [], projects: [], project: null, secrets: [] };
    this.values = {};
    this.inputs = {};
    this.error = "";
    this.busy = false;
    this.focusedKey = null;
    this.handle = cx.focus_handle();
    this.customTeams = [];
    this.teamName = InputState.new({ placeholder: "Team name" });
    this.teamPick(TEAMS[0].id);
    cx.spawn(async (cx) => { this.customTeams = (await loadCustomTeams()).teams; cx.notify(); });
    this.build(cx);
    // Machine passwords: the saved one is shown (plain text) so you can see / change it.
    if ((this.p.kind === "vm-password" || this.p.kind === "vm-sudo") && this.p.machine && !this.p.tour) {
      cx.spawn(async (cx) => {
        const r = await hp(["vm", "getpass", this.p.machine], { which: this.p.kind === "vm-sudo" ? "sudo" : "ssh" });
        const st = this.inputs.password;
        if (r.ok && st && !String(this.values.password ?? "")) { st.set_value(r.out); this.values.password = r.out; }
        else if (st && !r.ok) { try { st.set_placeholder?.("Not saved yet"); } catch {} }
        cx.notify();
      });
    }
    cx.spawn(async (cx) => {
      this.data.machines = await loadMachines();
      this.data.projects = await listProjects();
      this.data.secrets = await loadSecrets();
      if (this.p.project) this.data.project = await loadProject(this.p.project);
      this.spec = spec(this.p, this.data);
      for (const f of this.spec.fields) if ((f.type === "choice" || f.type === "multi" || f.type === "seg") && this.values[f.key] === undefined) this.values[f.key] = f.value;
      if (this.p.mode) this.values.mode = this.p.mode;
      const accessNames = this.p.kind === "loose-agent" ? this.data.machines.map((m) => m.name) : (this.data.project?.machines ?? []);
      this.access = Object.fromEntries(accessNames.map((n) => [n, { on: this.p.kind !== "loose-agent", sudo: false }]));
      if (this.p.kind === "task-add" && !this.values.for) this.values.for = this.spec.fields.find((f) => f.key === "for")?.value ?? "";
      if (this.p.kind === "task-assign" && !this.values.for) this.values.for = this.spec.fields[0]?.value ?? "";
      cx.notify();
    });
  }

  // Text inputs are created once (typed text survives when machine/project lists arrive).
  build(cx) {
    this.spec = spec(this.p, this.data);
    let first = null;
    for (const f of this.spec.fields) {
      const type = f.type ?? "text";
      if (type === "multi" || type === "access") this.filterState(f.key);
      if (["choice", "multi", "seg", "team", "access", "switch", "import"].includes(type)) { this.values[f.key] = f.value; continue; }
      this.values[f.key] = f.value ?? "";
      const st = type === "textarea"
        ? TextareaState.new({ value: f.value ?? "", placeholder: f.ph ?? "", rows: f.rows ?? 3 })
        : InputState.new({ value: f.value ?? "", placeholder: f.ph ?? "" });
      if (type === "masked") st.set_masked(true);
      st.on("change", (_e, cx) => { this.values[f.key] = st.value(); cx.notify(); });
      if (type !== "textarea") st.on("submit", (_e, cx) => this.submit(cx));
      st.on("focus", (_e, cx) => { this.focusedKey = f.key; cx.notify(); });
      this.inputs[f.key] = st;
      first ??= st;
    }
    if (first) { first.focus(); cx.timer.after(250, () => first.focus()); }
  }

  close() { closeOverlay(this.p.overlay); }

  // Search field of a long list (multi / machine access). Created outside render.
  filterState(key) {
    this.filters ??= {}; this.filterQ ??= {};
    if (!this.filters[key]) {
      const st = InputState.new({ placeholder: "Search" });
      st.on("change", (_e, cx) => { this.filterQ[key] = st.value().trim().toLowerCase(); cx.notify(); });
      this.filters[key] = st;
    }
    return this.filters[key];
  }
  searchBox(t, key) {
    const q = this.filterQ?.[key] ?? "";
    return h_flex().id(`mp-f-q-${key}`).flex_1().h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).bg(t.background).border_1().border_color(q ? t.accent : t.input)
      .child(iconEl("search", t.dim, 12))
      .child(Input.new(this.filterState(key)).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground))
      .when(Boolean(q), (el) => el.child(div().id(`mp-f-qx-${key}`).cursor_pointer().text_size(T.text.xs).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.filters[key].set_value(""); this.filterQ[key] = ""; cx.notify(); }).child("Clear")));
  }

  // Team mode: an editable copy of a template (built-in or your own): names, roles,
  // engine per agent, who is included. Rows can be added and the result saved as a team.
  allTeams() {
    return [...TEAMS, ...(this.customTeams ?? []).map((c) => ({ ...c, custom: true, glyph: c.glyph ?? "users", color: c.color ?? "#76818f" }))];
  }
  teamRow(a) {
    const name = InputState.new({ value: a.name ?? "", placeholder: "agent-name" });
    const role = InputState.new({ value: a.role ?? "", placeholder: "What this agent does" });
    return { name, role, app: a.app ?? "claude", on: true, prompt: a.prompt ?? "" };
  }
  teamPick(id) {
    this.teamId = id;
    const team = this.allTeams().find((x) => x.id === id);
    this.teamAgents = team ? team.agents.map((a) => this.teamRow(a)) : [this.teamRow({}), this.teamRow({ app: "codex" })];
    this.teamName?.set_value(team?.custom ? team.name : "");
  }
  async saveTeam(cx) {
    const name = this.teamName.value().trim();
    if (!name) { this.error = "Give the team a name first."; cx.notify(); return; }
    const team = {
      id: `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, desc: "Your team",
      agents: this.teamAgents.filter((a) => a.name.value().trim()).map((a) => ({ name: a.name.value().trim(), role: a.role.value().trim(), app: a.app, prompt: a.prompt })),
    };
    if (!team.agents.length) { this.error = "Add at least one agent."; cx.notify(); return; }
    const ok = await changeCustomTeams((all) => [...all.filter((x) => x.id !== team.id), team]);
    this.customTeams = (await loadCustomTeams()).teams;
    this.teamId = team.id;
    this.error = ok ? "" : "Could not save the team.";
    if (ok) toast(`Team "${name}" saved`, `${team.agents.length} agents`, "success");
    cx.notify();
  }

  teamEditor(t) {
    const input = (st, w) => Input.new(st).h(28).px(8).rounded(T.r.ctrl).border_1().border_color(t.border).bg(t.background).text_size(T.text.sm).text_color(t.foreground)
      .when(Boolean(w), (el) => el.w(w).flex_none()).when(!w, (el) => el.flex_1().min_w(0));
    const teamCard = (x) => {
      const on = x.id === this.teamId;
      return v_flex().id(`mp-team-${x.id}`).w_full().min_w(0).h(40).px(12).justify_center().rounded(T.r.panel).cursor_pointer().tooltip(x.desc ?? x.name)
        .border_1().border_color(on ? t.accent : t.border).bg(on ? `${t.accent.slice(0, 7)}1f` : t.raised)
        .on_click((_e, cx) => { this.teamPick(x.id); cx.notify(); })
        .child(h_flex().gap(8).items_center()
          .child(tile(x.name, { size: 22, color: x.color, glyph: x.glyph, radius: 6 }))
          .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).font_semibold().child(x.name))
          .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(String(x.agents.length)))
          .when(Boolean(x.custom), (el) => el.child(h_flex().id(`mp-team-del-${x.id}`).size(18).rounded(T.r.chip).items_center().justify_center().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(BAD))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => { await changeCustomTeams((all) => all.filter((y) => y.id !== x.id)); this.customTeams = (await loadCustomTeams()).teams; if (this.teamId === x.id) this.teamPick(TEAMS[0].id); cx.notify(); }); })
            .child(iconEl("x", null, 11)))));
    };
    const engine = (a, i, app, label) => h_flex().id(`mp-team-e-${i}-${app}`).h(24).px(8).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.xs).font_medium()
      .bg(a.app === app ? t.surface : clear).text_color(a.app === app ? t.foreground : t.dim)
      
      .on_click((_e, cx) => { a.app = app; cx.notify(); }).child(label);
    return v_flex().gap(8)
      .child(grid("mp-team-cards", this.allTeams().map(teamCard), 636, { min: 180, gap: 8 }))
      .child(v_flex().rounded(T.r.panel).border_1().border_color(t.border).overflow_hidden()
        .children(this.teamAgents.map((a, i) => h_flex().id(`mp-team-a-${i}`).h(44).px(12).gap(8).items_center()
          .when(i > 0, (el) => el.border_t_1().border_color(t.border))
          .child(h_flex().id(`mp-team-on-${i}`).flex_none().size(18).rounded(T.r.chip).items_center().justify_center().cursor_pointer()
            .border_1().border_color(a.on ? t.accent : t.input).bg(a.on ? t.accent : clear)
            .on_click((_e, cx) => { a.on = !a.on; cx.notify(); })
            .when(a.on, (el) => el.child(iconEl("check", t.accent_foreground, 12))))
          .child(input(a.name, 140)).child(input(a.role))
          .child(h_flex().flex_none().p(2).gap(2).rounded(T.r.panel).bg(t.background).border_1().border_color(t.border)
            .child(engine(a, i, "claude", "Claude")).child(engine(a, i, "codex", "Codex")))
          .child(h_flex().id(`mp-team-rm-${i}`).flex_none().size(22).rounded(T.r.ctrl).items_center().justify_center().cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.teamAgents.splice(i, 1); cx.notify(); })
            .child(iconEl("x", null, 12)))))
        .child(h_flex().h(40).px(12).gap(8).items_center().border_t_1().border_color(t.border).bg(t.raised)
          .child(h_flex().id("mp-team-addrow").h(28).px(12).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.sm).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.teamAgents.push(this.teamRow({})); cx.notify(); })
            .child(iconEl("plus", null, 12)).child("Add Agent"))
          .child(h_flex().id("mp-team-blank").h(28).px(12).gap(6).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.sm).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.teamPick("__new"); cx.notify(); })
            .child(iconEl("layers", null, 12)).child("Start Empty"))
          .child(div().flex_1())
          .child(input(this.teamName, 170))
          .child(h_flex().id("mp-team-save").h(28).px(12).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.sm).font_medium()
            .border_1().border_color(t.border).bg(t.surface).hover((s) => s.border_color(t.accent))
            .on_click((_e, cx) => cx.spawn(async (cx) => this.saveTeam(cx)))
            .child("Save as Team"))));
  }

  visible() { return this.spec.fields.filter((f) => !f.show || f.show(this.values)); }

  missing() {
    return this.visible().find((f) => !f.optional && f.type !== "multi" && !String(this.values[f.key] ?? "").trim());
  }

  submit(cx) {
    if (this.busy) return;
    // Opened by the tutorial: show how it works, never save anything.
    if (this.p.tour) { toast("Tutorial", "Nothing was saved — this was just a demo.", "info"); this.close(); return; }
    if (this.p.kind === "vm-import") return this.runImport(cx);
    const miss = this.missing();
    if (miss) { this.error = `Required: ${miss.label}`; cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const err = await this.save();
      this.busy = false;
      if (err) { this.error = err; cx.notify(); return; }
      // Show the result everywhere at once (and once more when a started agent has registered).
      setShared("mp.reloadAt", Date.now());
      cx.timer.after(3000, () => setShared("mp.reloadAt", Date.now()));
      this.close();
    });
  }

  // ---- vm-import: the text is parsed on every change (cached), previewed, then imported row by row.
  imp() {
    const text = this.values.text ?? "";
    const names = this.data.machines.map((m) => m.name).join(",");
    if (this._imp && this._imp.text === text && this._imp.names === names) return this._imp;
    if (this._imp && this._imp.text !== text) { this.results = {}; this.importDone = false; }
    const res = parseMachines(text);
    const projs = this.data.projects.filter((x) => !x.loose);
    for (const r of res.rows) {
      r.exists = this.data.machines.some((m) => m.name === r.name);
      r.slugs = []; r.unknown = [];
      for (const pr of r.projects) {
        const f = projs.find((x) => x.slug === pr || x.slug === slugify(pr) || slugify(x.name) === slugify(pr));
        if (f) r.slugs.push(f.slug); else r.unknown.push(pr);
      }
      const prev = this._imp?.rows.find((x) => x.name === r.name);
      r.on = prev ? prev.on : !r.error;
    }
    this._imp = { text, names, ...res };
    return this._imp;
  }
  willImport(r) { return r.on && !r.error && (!r.exists || Boolean(this.values.overwrite)); }

  async loadFile(path, cx) {
    const text = await readTextFile(path).catch(() => null);
    if (text == null) { this.error = `Cannot read ${path}`; cx.notify(); return; }
    this.inputs.text?.set_value(text);
    this.values.text = text; this.error = ""; cx.notify();
  }

  runImport(cx) {
    if (this.importDone) { this.close(); return; }
    const imp = this.imp();
    const todo = imp.rows.filter((r) => this.willImport(r));
    if (!todo.length) { this.error = imp.error || (imp.rows.length ? "Nothing selected to import." : "Paste machines or load a file."); cx.notify(); return; }
    if (demo()) { toast("Demo mode — nothing imported", `${todo.length} machine${todo.length > 1 ? "s" : ""} parsed`, "info"); return; }
    this.busy = true; this.error = ""; this.results = {}; cx.notify();
    cx.spawn(async (cx) => {
      let done = 0;
      for (const [i, r] of todo.entries()) {
        this.progress = `${i + 1}/${todo.length}`;
        this.results[r.name] = [null, "Adding…"]; cx.notify();
        const res = await hp(["vm", "add", r.name], { p: this.p.project || undefined, host: r.host, user: r.user, port: r.port, os: r.os || undefined, desc: r.desc || undefined, value: r.password || undefined, sudo: r.sudo ? "on" : "off" }, 90000);
        if (!res.ok) { this.results[r.name] = [BAD, res.err || "Failed"]; cx.notify(); continue; }
        done++;
        const missed = [...r.unknown];
        for (const slug of r.slugs) if (!(await hp(["project", "attach", r.name], { p: slug })).ok) missed.push(slug);
        const trusted = res.out.split(/\r?\n/).pop().trim() === "trusted";
        this.results[r.name] = missed.length ? [WARN, `Added · no project ${missed.join(", ")}`]
          : !r.password ? [OK, "Added"] : trusted ? [OK, "Added · key installed"] : [WARN, "Added · key not installed"];
        cx.notify();
      }
      this.busy = false; this.progress = ""; this.importDone = true;
      this.data.machines = await loadMachines();
      toast(`Imported ${done} of ${todo.length} machines`, done < todo.length ? "Some rows failed, see the list." : "", done === todo.length ? "success" : "info");
      cx.notify();
    });
  }

  importLabel() {
    if (this.importDone) return "Done";
    if (this.busy) return `Importing ${this.progress ?? ""}…`;
    const k = this.imp().rows.filter((r) => this.willImport(r)).length;
    return k ? `Import ${k} machine${k === 1 ? "" : "s"}` : "Import";
  }

  importPanel(t) {
    const imp = this.imp();
    const n = imp.rows.length, exist = imp.rows.filter((r) => r.exists && !r.error).length;
    const res = this.results ?? {};
    const cell = (w, el, color) => (w ? div().w(w).flex_none() : div().flex_1()).min_w(0).truncate().text_size(T.text.xs).text_color(color ?? t.foreground).child(el);
    const tools = h_flex().pt(8).gap(8).items_center()
      .child(button(t, "mp-imp-load", "Load File…", (_e, cx) => cx.spawn(async (cx) => { const path = await pickFile(); if (path) await this.loadFile(path, cx); }), { small: true, iconName: "paperclip" }))
      .child(button(t, "mp-imp-ex", "Copy Example", (_e, cx) => cx.spawn(async () => { const ok = await copyText(IMPORT_EXAMPLE); toast(ok ? "Example copied" : "Copy failed", ok ? "CSV with every column" : "", ok ? "success" : "error"); }), { small: true, iconName: "copy" }))
      .child(div().flex_1())
      .when(Boolean(imp.format), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(`${imp.format} · ${n} row${n === 1 ? "" : "s"}`)));
    if (!n) return v_flex().child(tools).when(Boolean(imp.error), (el) => el.child(div().pt(12).text_size(T.text.xs).text_color(BAD).child(imp.error)));
    const status = (r) => res[r.name] ? [res[r.name][0] ?? t.muted, res[r.name][1]]
      : r.error ? [BAD, r.error] : r.exists ? [this.values.overwrite ? WARN : t.dim, this.values.overwrite ? "Overwrite" : "Exists · skip"]
      : r.unknown.length ? [WARN, `New · no project ${r.unknown.join(", ")}`] : [OK, "New"];
    return v_flex().child(tools)
      .when(exist > 0, (el) => el.child(h_flex().pt(12).gap(8).items_center()
        .child(switchEl(t, "mp-imp-ow", Boolean(this.values.overwrite), (cx) => { this.values.overwrite = !this.values.overwrite; cx.notify(); }, this.busy))
        .child(div().text_size(T.text.sm).text_color(this.values.overwrite ? t.foreground : t.muted).child(`Overwrite existing (${exist})`))))
      .child(v_flex().mt(12).rounded(T.r.panel).border_1().border_color(t.border).overflow_hidden()
        .child(h_flex().h(28).px(12).gap(6).items_center().bg(t.raised)
          .child(div().w(16).flex_none())
          .child(cell(104, "Name", t.dim)).child(cell(0, "Host", t.dim)).child(cell(64, "User", t.dim)).child(cell(36, "Port", t.dim))
          .child(cell(30, "Pass", t.dim)).child(cell(30, "Sudo", t.dim)).child(cell(70, "Projects", t.dim)).child(cell(112, "Status", t.dim)))
        .child(scrollY("mp-imp-rows", v_flex().max_h(230)
          .children(imp.rows.map((r, i) => {
            const [sc, st] = status(r);
            const can = !r.error && !this.busy && !this.importDone;
            return h_flex().id(`mp-imp-r-${i}`).flex_none().h(28).px(12).gap(6).items_center().border_t_1().border_color(t.border)
              .when(!this.willImport(r) && !res[r.name], (el) => el.opacity(0.55))
              .child(h_flex().id(`mp-imp-on-${i}`).flex_none().size(16).rounded(T.r.chip).items_center().justify_center().when(can, (el) => el.cursor_pointer())
                .border_1().border_color(r.on && !r.error ? t.accent : t.input).bg(r.on && !r.error ? t.accent : clear)
                .on_click((_e, cx) => { if (can) { r.on = !r.on; cx.notify(); } })
                .when(r.on && !r.error, (el) => el.child(iconEl("check", t.accent_foreground, 11))))
              .child(cell(104, r.name)).child(cell(0, r.host, t.muted)).child(cell(64, r.user || "—", t.muted)).child(cell(36, r.port, t.muted))
              .child(cell(30, r.password ? "•••" : "—", t.dim)).child(cell(30, r.sudo ? "yes" : "no", r.sudo ? t.foreground : t.dim))
              .child(cell(70, r.projects.join(", ") || "—", t.muted))
              .child(div().w(112).flex_none().min_w(0).truncate().text_size(T.text.xs).text_color(sc).tooltip(st).child(st));
          })), { grow: false })));
  }

  // Returns an error message or null.
  async save() {
    const v = this.values, p = this.p, slug = p.project;
    const s = (k) => String(v[k] ?? "").trim();
    switch (p.kind) {
      case "project-new": {
        const r = await hp(["project", "new", s("name")], { desc: s("desc") || undefined, machines: v.machines?.length ? v.machines : undefined });
        if (!r.ok) return r.err;
        selectProject(r.out.split(/\r?\n/).pop().trim(), "overview");
        showCenter("mp-view");
        return null;
      }
      case "project-edit": {
        const r = await hp(["project", "set"], { p: slug, name: s("name"), desc: s("desc") });
        return r.ok ? null : r.err;
      }
      case "vm-add": {
        const name = s("name");
        const r = await hp(["vm", "add", name], { p: slug, host: s("host"), user: s("user"), port: s("port") || "22", desc: s("desc") || undefined, value: v.password, sudo: v.sudo ? "on" : "off" }, 90000);
        if (!r.ok) return r.err;
        // Same slug rules as hp (Polish letters mapped, everything else to "-").
        const map = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
        const real = [...name.toLowerCase()].map((c) => map[c] ?? c).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
        // No key yet: install it right away in the machine's view (password typed once there).
        if (r.out.includes("needs-trust")) installKey(real);
        else { toast(`Machine ${real} is ready`, "Key-based login works.", "success"); if (!slug) openVm(real); }
        return null;
      }
      case "vm-edit": {
        const r = await hp(["vm", "set", p.machine], { host: s("host"), port: s("port"), user: s("user"), desc: s("desc") });
        return r.ok ? null : r.err;
      }
      case "vm-sudo": {
        const r = await hp(["vm", "sudo", p.machine], { user: s("user"), value: v.password });
        if (r.ok) toast(`Sudo saved for ${p.machine}`, `Agents: hp sudo ${p.machine} "…"`, "success");
        return r.ok ? null : r.err;
      }
      case "vm-password": {
        const r = await hp(["vm", "password", p.machine], { value: v.password });
        if (!r.ok) return r.err;
        toast(`SSH password saved for ${p.machine}`, "Checking the connection now. Install SSH Key uses it, no typing.", "success");
        setShared("mp.vmProbeAsk", { vm: p.machine, at: Date.now() });
        return null;
      }
      case "vm-attach": {
        for (const m of v.machines ?? []) {
          const r = await hp(["project", "attach", m], { p: slug });
          if (!r.ok) return r.err;
        }
        return null;
      }
      case "task-add": {
        if (!v.for) return "Add an agent to the project first.";
        const after = s("after").split(/[\s,;]+/).map((x) => x.replace(/^#/, "")).filter(Boolean);
        if (after.some((x) => !/^\d+$/.test(x))) return "Waits for: task numbers, e.g. 2, 5";
        // hp has no --source on add: the agent starts the task in that source (hp task start <id> --source <name>).
        const desc = [s("desc"), v.source ? `Source: ${v.source} (hp task start <id> --source ${v.source})` : ""].filter(Boolean).join("\n\n");
        if (this.p.tour || demo()) { toast("Demo mode", "Nothing was created.", "info"); return null; }
        // Epic: owned by the lead (it gets "break it into tasks"), no column (its status follows its tasks).
        const epic = v.kind === "epic" && this.p.epic == null;
        const who = v.for === "@lead" ? leadOf(this.data.project) ?? "team" : v.for;
        const r = await hp(["task", "add", s("title")], { p: slug, as: "ty", for: who, priority: v.priority, status: epic ? undefined : v.status, machine: v.machine || undefined,
          after: after.length ? after.join(",") : undefined, desc: desc || undefined, kind: epic ? "epic" : undefined, epic: this.p.epic != null ? String(this.p.epic) : undefined });
        if (r.ok && epic) toast(`Epic created`, `${who === "team" ? "The lead" : who} will break it into tasks; you approve the plan in the Mailbox.`, "success");
        return r.ok ? null : r.err;
      }
      case "task-assign": {
        const r = await hp(["task", "assign", String(p.task)], { p: slug, as: "ty", for: v.for });
        return r.ok ? null : r.err;
      }
      case "agent-new": {
        if ((v.mode ?? "single") === "team") {
          const chosen = this.teamAgents.filter((a) => a.on && a.name.value().trim())
            .map((a) => ({ name: a.name.value().trim(), role: a.role.value().trim(), app: a.app, prompt: a.prompt || `Your role: ${a.role.value().trim() || "team member"}. ${COMMON_PROMPT}` }));
          if (!chosen.length) return "Pick at least one agent with a name.";
          const joined = [];
          for (const a of chosen) {
            const r = await hp(["agent", "join", a.name], { p: slug, role: a.role, app: a.app, risk: v.risk ?? "balanced", ...accessArgs(this.access) });
            if (!r.ok) return r.err;
            joined.push({ ...a, risk: v.risk ?? "balanced", name: r.out.split(/\r?\n/).pop().trim() });
          }
          const project = await loadProject(slug);
          const goal = s("goal");
          for (const a of joined) startAgent(project, a, `${a.prompt}${goal ? ` Team goal: ${goal}` : ""} Team: ${joined.map((x) => `${x.name} (${x.role})`).join(", ")}.`);
          toast(`${(this.allTeams().find((x) => x.id === this.teamId) ?? {}).name ?? "Team"} launched`, joined.map((a) => a.name).join(", "), "success");
          showCenter("mp-terms");
          return null;
        }
        const r = await hp(["agent", "join", s("name")], { p: slug, role: s("role") || undefined, app: v.app, risk: v.risk ?? "balanced", ...accessArgs(this.access) });
        if (!r.ok) return r.err;
        const project = await loadProject(slug);
        startAgent(project, { name: r.out.split(/\r?\n/).pop().trim(), role: s("role"), app: v.app, risk: v.risk ?? "balanced" }, s("goal"));
        showCenter("mp-terms");
        return null;
      }
      // Loose agent = a project of its own (hp project new --loose yes) with one agent in it.
      case "loose-agent": {
        const name = s("name");
        const acc = Object.entries(this.access ?? {});
        const on = acc.filter(([, a]) => a.on).map(([n]) => n), sudo = acc.filter(([, a]) => a.on && a.sudo).map(([n]) => n);
        const r = await hp(["project", "new", name], { loose: "yes", machines: on.length ? on.join(",") : undefined });
        if (!r.ok) return r.err;
        const ls = r.out.split(/\r?\n/).pop().trim();
        const j = await hp(["agent", "join", name], { p: ls, role: s("role") || undefined, app: v.app ?? "claude", risk: "balanced", sudo: sudo.length ? sudo.join(",") : undefined });
        if (!j.ok) return j.err;
        const real = j.out.split(/\r?\n/).pop().trim() || name;
        for (const c of v.creds ?? []) await hp(["secret", "share", c], { p: ls });
        toast(`Agent ${real} created`, "Write to it in the chat to start it.", "success");
        import("./toolbar.js").then((m) => { m.openAgentPage(ls, real, "agents"); showCenter("mp-view"); }).catch(() => {});
        return null;
      }
      case "project-secrets": {
        const want = new Set(v.creds ?? []);
        for (const x of this.data.secrets ?? []) {
          const has = (x.projects ?? []).includes(p.project);
          const r = want.has(x.name) && !has ? await hp(["secret", "share", x.name], { p: p.project })
            : !want.has(x.name) && has ? await hp(["secret", "unshare", x.name], { p: p.project }) : { ok: true };
          if (!r.ok) return r.err;
        }
        return null;
      }
      case "skill-edit": return saveSkill(p.edit, { name: s("name"), desc: s("desc"), body: String(v.body ?? "") }, v.agents ?? []);
      case "mcp-edit": return saveServer(p.edit, { name: s("name"), desc: s("desc"), transport: v.transport ?? "stdio", command: s("command"), args: String(v.args ?? ""),
        env: String(v.env ?? ""), cwd: s("cwd"), url: s("url"), headers: String(v.headers ?? ""), secret: v.secret ?? "" }, v.agents ?? [], p.tpl?.secret === "optional" || !p.tpl?.secret);
      // Clipboard (clipboard.js): add / edit a snippet.
      case "snippet": {
        const item = { id: p.edit?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: v.kind ?? "note", title: s("title"), text: String(v.text ?? ""),
          pinned: p.edit?.pinned ?? false, updated: new Date().toISOString() };
        const ok = await changeClips((all) => (p.edit ? all.map((x) => (x.id === p.edit.id ? item : x)) : [item, ...all]));
        return ok ? null : "Could not save (the clipboard file changed); try again.";
      }
      case "message": {
        const r = await hp(["say", s("text")], { p: slug, as: "ty", to: v.to, task: p.task ? String(p.task) : undefined });
        return r.ok ? null : r.err;
      }
      case "source-add":
      case "source-edit": {
        // "machine:/path deployed service" lines -> --vm a,b and --deployed c#service,d
        const plain = [], deployed = [];
        for (const line of s("vms").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
          const [loc, flag, svc] = line.split(/\s+/);
          if (flag === "deployed") deployed.push(svc ? `${loc}#${svc}` : loc); else plain.push(loc);
        }
        const remote = ["github", "gitlab", "bitbucket", "other-remote"].includes(v.kind);
        const opts = { p: slug, kind: v.kind, url: remote ? s("url") : "", branch: s("branch") || "main", secret: remote ? (v.secret ?? "") : "", local: s("local"), vm: plain.join(","), deployed: deployed.length ? deployed.join(",") : undefined };
        const r = p.kind === "source-add" ? await hp(["source", "add", s("name")], opts) : await hp(["source", "set", p.source.name], opts);
        return r.ok ? null : r.err;
      }
    }
    return null;
  }

  // ---- task-add: compact layout. 11px dim labels above fields, 8 px label gap, 12 px between fields.
  dropdown(t, f, w) {
    const key = f.key, open = this.menu === key;
    const cur = f.choices.find(([v]) => v === this.values[key]) ?? f.choices[0];
    return Popover.new(`mp-f-dd-${key}`).anchor("top_left").open(open)
      .on_open_change((o, cx) => { this.menu = o ? key : null; cx.notify(); })
      .trigger(h_flex().id(`mp-f-ddt-${key}`).w(w).h(T.h.input).px(T.sp.md).gap(T.sp.sm).items_center().rounded(T.r.ctrl).cursor_pointer()
        .border_1().border_color(open ? t.accent : t.input).bg(t.background).text_size(T.text.sm)
        .child(div().flex_1().min_w(0).truncate().text_color(this.values[key] ? t.foreground : t.muted).child(cur?.[2] ?? cur?.[1] ?? ""))
        .child(iconEl("chevron-down", t.dim, 11)))
      .content(v_flex().id(`mp-f-ddl-${key}`).w(Math.max(w, 180)).max_h(240).overflow_y_scroll().py(T.sp.xs).mt(T.sp.xs).rounded(T.r.panel).bg(t.popover).border_1().border_color(t.border).shadow_md()
        .children(f.choices.map(([val, text]) => h_flex().id(`mp-f-dd-${key}-${val || "none"}`).h(T.h.rowDense).mx(T.sp.xs).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.ctrl).cursor_pointer()
          .text_size(T.text.sm).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.values[key] = val; this.menu = null; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(text))
          .child(this.values[key] === val ? iconEl("check", t.accent, 12) : div().w(12)))));
  }
  taskAdd(t, fixed) {
    const F = Object.fromEntries(this.spec.fields.map((f) => [f.key, f]));
    const lab = (text) => div().pb(T.sp.sm).text_size(T.text.xs).font_medium().text_color(t.muted).child(text);
    const block = (text, control) => v_flex().min_w(0).child(lab(text)).child(control);
    const box = (key, el) => el.w_full().px(T.sp.md).rounded(T.r.ctrl).border_1().border_color(this.focusedKey === key ? t.accent : t.input)
      .bg(t.background).text_size(T.text.sm).text_color(t.foreground);
    const seg = (key) => segmented(t, `mp-f-seg-${key}`, F[key].choices, this.values[key], (cx, x) => { this.values[key] = x; cx.notify(); }, { compact: true });
    const more = Boolean(this.moreOpen);
    const extra = [this.values.machine, String(this.values.after ?? "").trim(), this.values.source].filter(Boolean).length;
    const inEpic = this.p.epic != null ? (this.data.project?.tasks ?? []).find((x) => String(x.id) === String(this.p.epic)) ?? { id: this.p.epic, title: "" } : null;
    const isEpic = !inEpic && this.values.kind === "epic";
    const lead = leadOf(this.data.project);
    return v_flex().id("mp-form-body").px(24).pt(fixed ? 0 : T.sp.lg).gap(T.sp.lg)
      // Task / Epic switch (compact, top); an epic goes to the lead by default, a task to "Any".
      .when(!inEpic, (el) => el.child(h_flex().gap(T.sp.md).items_center()
        .child(segmented(t, "mp-f-seg-kind", F.kind.choices, this.values.kind ?? "task", (cx, x) => {
          this.values.kind = x;
          if (x === "epic" && lead && !fixed && this.values.for === "team") { this.forBeforeEpic = this.values.for; this.values.for = "@lead"; }
          if (x === "task" && this.forBeforeEpic) { this.values.for = this.forBeforeEpic; this.forBeforeEpic = null; }
          cx.notify();
        }, { compact: true }))))
      .when(Boolean(inEpic), (el) => el.child(h_flex().gap(T.sp.sm).items_center().text_size(T.text.sm)
        .child(div().flex_none().w(3).h(14).rounded(2).bg(OK))
        .child(div().flex_none().text_size(T.text.xs).font_medium().text_color(OK).child("EPIC"))
        .child(div().min_w(0).truncate().text_color(t.muted).child(`#${inEpic.id} ${inEpic.title}`))))
      // Fixed by the context (Assign Task on an agent): a quiet line instead of a picker.
      .when(Boolean(fixed), (el) => el.child(h_flex().gap(T.sp.xs).text_size(T.text.sm)
        .child(div().text_color(t.dim).child("for")).child(div().text_color(t.muted).font_medium().child(String(fixed)))))
      .child(block("Title", box("title", Input.new(this.inputs.title)).h(T.h.input)))
      .child(block("Description", box("desc", Textarea.new(this.inputs.desc)).py(T.sp.sm)))
      .child(h_flex().gap(T.sp.lg).items_start()
        .when(!fixed, (el) => el.child(block(isEpic ? "Lead" : "Agent", this.dropdown(t, F.for, isEpic ? 200 : 140)).flex_none()))
        .child(block("Priority", seg("priority")).flex_none())
        .when(!isEpic, (el) => el.child(block("Column", seg("status")).flex_none())))
      .when(!isEpic, (el) => el.child(v_flex()
        .child(h_flex().id("mp-f-more").h(T.h.btnSm).gap(T.sp.xs).items_center().cursor_pointer().text_size(T.text.xs).text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.moreOpen = !more; cx.notify(); })
          .child(iconEl(more ? "chevron-down" : "chevron-right", t.dim, 11))
          .child("More options")
          .when(!more && extra > 0, (el) => el.child(div().text_color(t.dim).child(`· ${extra} set`))))
        .when(more, (el) => el.child(h_flex().pt(T.sp.md).gap(T.sp.lg).items_start()
          .child(block("Machine", this.dropdown(t, F.machine, 140)).flex_none())
          .child(block("Waits for", box("after", Input.new(this.inputs.after)).h(T.h.input)).w(96).flex_none())
          .child(block("Source / worktree", this.dropdown(t, F.source, 140)).flex_none())))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(T.text.xs).text_color(t.blocked ?? BAD).whitespace_normal().child(this.error)));
  }

  render() {
    if (this.wiz) return this.wiz.render();
    const t = theme();
    const sp = this.spec;
    // Design previews only (dev bridge): shared "mp.devFormMore" = { at } opens "More options" of New Task.
    const dfm = shared("mp.devFormMore");
    if (this.p.kind === "task-add" && dfm && dfm.at !== this.dfmAt && Date.now() - dfm.at < 15000) { this.dfmAt = dfm.at; this.moreOpen = true; }
    // One field rhythm for every dialog (Primer FormControl / Geist): 11px medium label, 6px gap, 28px control.
    const label = (f) => div().pt(T.sp.lg).pb(T.sp.sm).text_size(T.text.xs).font_medium().text_color(t.muted).child(f.labelFn ? f.labelFn(this.values) : f.label);
    // Every choice chip is one control height (26), the Engine chips too (icon + label).
    const chip = (f, val, text, on, onClick, check) => h_flex().id(`mp-ch-${f.key}-${val || "none"}`).h(T.h.btnSm).px(f.big ? T.sp.lg : T.sp.md).gap(6).rounded(T.r.ctrl)
      .items_center().cursor_pointer().text_size(f.big ? T.text.sm : T.text.xs).font_medium()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : clear).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .when(f.big, (el) => el.child(iconEl(val === "codex" ? "terminal" : "bot", on ? t.accent : t.dim, T.icon.row)))
      .child(text)
      .when(Boolean(check && on), (el) => el.child(iconEl("check", t.accent, 12)));
    const field = (f) => {
      const type = f.type ?? "text";
      let control;
      if (type === "team") {
        return v_flex().child(label(f)).child(this.teamEditor(t));
      }
      if (type === "import") return this.importPanel(t);
      if (type === "access") {
        return v_flex().child(label(f)).child(accessEditor(t, this.access ?? {}, this.data.machines, "mp-f-acc", null,
          { q: this.filterQ?.[f.key] ?? "", search: Object.keys(this.access ?? {}).length > 8 ? this.searchBox(t, f.key) : null }));
      }
      if (type === "switch") {
        const on = Boolean(this.values[f.key]);
        return h_flex().pt(12).gap(8).items_center()
          .child(switchEl(t, `mp-f-sw-${f.key}`, on, (cx) => { this.values[f.key] = !on; cx.notify(); }))
          .child(div().text_size(T.text.sm).text_color(on ? t.foreground : t.muted).child(f.label));
      }
      if (type === "seg") {
        const val = this.values[f.key];
        return v_flex().child(label(f))
          .child(h_flex().child(segmented(t, `mp-f-seg-${f.key}`, f.choices, val, (cx, x) => { this.values[f.key] = x; cx.notify(); }, { dots: f.dots })))
          .when(Boolean(f.hint), (el) => el.child(div().pt(T.sp.xs).text_size(T.text.xs).text_color(t.dim).truncate().child(f.hint(val))));
      }
      if (type === "choice") {
        control = h_flex().flex_wrap().gap(6).children(f.choices.map(([val, text]) => chip(f, val, text, this.values[f.key] === val, () => { this.values[f.key] = val; })));
      } else if (type === "multi") {
        const set = new Set(this.values[f.key] ?? []);
        const chips = h_flex().flex_wrap().gap(6).pr(T.sp.md).children(f.choices.map(([val, text]) => chip(f, val, text, set.has(val), () => {
          if (set.has(val)) set.delete(val); else set.add(val);
          this.values[f.key] = [...set];
        }, true)));
        // Many choices (machines, tokens, agents): search + a fixed-height scrolling list of rows with
        // a count and All / None (on what the search shows), so the dialog keeps its buttons on screen.
        const many = f.choices.length > 8;
        const q = this.filterQ?.[f.key] ?? "";
        const shown = q ? f.choices.filter(([val, text]) => `${text} ${val}`.toLowerCase().includes(q)) : f.choices;
        const link = (id, text, fn) => div().id(id).flex_none().cursor_pointer().text_size(T.text.xs).text_color(t.accent)
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
        const row = ([val, text], i) => {
          const on = set.has(val);
          return h_flex().id(`mp-f-mr-${f.key}-${i}`).flex_none().h(28).px(T.sp.md).gap(T.sp.md).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { if (on) set.delete(val); else set.add(val); this.values[f.key] = [...set]; cx.notify(); })
            .child(h_flex().flex_none().size(14).rounded(3).items_center().justify_center().border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : clear)
              .when(on, (el) => el.child(iconEl("check", t.accent_foreground ?? "#ffffff", 10))))
            .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(on ? t.foreground : t.muted).child(text));
        };
        control = !f.choices.length ? div().text_size(T.text.xs).text_color(t.dim).child("None available")
          : !many ? chips
          : v_flex().rounded(T.r.panel).border_1().border_color(t.border).overflow_hidden()
            .child(h_flex().flex_none().p(T.sp.sm).gap(T.sp.md).items_center().bg(t.raised)
              .child(this.searchBox(t, f.key))
              .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`${set.size} of ${f.choices.length}`))
              .child(link(`mp-f-all-${f.key}`, "All", () => { for (const [v] of shown) set.add(v); this.values[f.key] = [...set]; }))
              .child(link(`mp-f-none-${f.key}`, "None", () => { for (const [v] of shown) set.delete(v); this.values[f.key] = [...set]; })))
            .child(shown.length ? scrollY(`mp-f-multi-${f.key}`, v_flex().max_h(28 * 8).children(shown.map(row)), { grow: false })
              : h_flex().h(28).px(T.sp.md).items_center().text_size(T.text.sm).text_color(t.dim).child("No matches"));
      } else {
        const focused = this.focusedKey === f.key;
        const el = type === "textarea" ? Textarea.new(this.inputs[f.key]) : Input.new(this.inputs[f.key]);
        control = el.w_full().when(type !== "textarea", (e) => e.h(T.h.input)).px(T.sp.md).py(type === "textarea" ? T.sp.sm : 0).rounded(T.r.ctrl).border_1()
          .border_color(focused ? t.accent : t.input).bg(t.background).text_size(T.text.sm).text_color(t.foreground);
      }
      return v_flex().child(label(f)).child(control);
    };
    // Header and buttons stay put; only the fields scroll when the dialog is tall.
    const tall = TALL.has(this.p.kind);
    const compact = this.p.kind === "task-add";
    const fixedFor = compact && this.p.for ? this.p.for : null;
    return v_flex().id("mp-form").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .when(this.p.kind === "vm-import", (el) => el.on_drop((e, cx) => { const path = e.paths?.[0]; if (path) cx.spawn(async (cx) => this.loadFile(path, cx)); }))
      .w_full().when(tall, (el) => el.h_full()).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().px(24).pt(16).pb(4).gap(8).items_center()
        .child(div().flex_none().text_size(T.text.lg).font_semibold().child(compact && this.values.kind === "epic" && this.p.epic == null ? "New Epic" : compact && this.p.epic != null ? "New Task in Epic" : sp.title))
        .child(div().flex_1())
        .when(this.p.kind === "vm-add", (el) => el.child(h_flex().id("mp-f-import").h(24).px(8).gap(4).rounded(T.r.ctrl).items_center().cursor_pointer()
          .text_size(T.text.xs).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => { this.close(); openForm("vm-import", this.p.project ? { project: this.p.project } : {}); })
          .child(iconEl("layers", null, 12)).child("Import from File"))))
      .child(compact ? this.taskAdd(t, fixedFor) : ((body) => (tall ? scrollY("mp-form-body", body) : body.id("mp-form-body")))(v_flex().px(24)
        .children(this.visible().reduce((out, f, i, all) => {
          // `join: width` puts a field next to the previous one (Host + Port).
          if (f.join && i > 0) out[out.length - 1] = h_flex().gap(8).child(field(all[i - 1]).flex_1().min_w(0)).child(field(f).w(f.join).flex_none());
          else out.push(field(f));
          return out;
        }, []))
        .when(Boolean(this.error), (el) => el.child(div().mt(12).pl(T.sp.md).py(T.sp.xs).border_l_2().border_color(t.blocked ?? BAD).text_size(T.text.xs).text_color(t.blocked ?? BAD).whitespace_normal().child(this.error)))))
      // Footer: key hints left (Enter submits from any one-line field, Esc cancels), buttons right.
      .child(h_flex().flex_none().px(24).pt(T.sp.xl).pb(T.sp.xl).gap(T.sp.md).items_center().when(tall, (el) => el.border_t_1().border_color(t.border).mt(12))
        .child(h_flex().flex_1().min_w(0).gap(T.sp.xs).items_center().text_size(T.text.xs).text_color(t.dim)
          .child(kbd(t, "Enter")).child(div().pr(T.sp.md).child("submit")).child(kbd(t, "Esc")).child(div().child("cancel")))
        .child(button(t, "mp-f-cancel", "Cancel", () => this.close()))
        .child(button(t, "mp-f-ok", this.p.kind === "vm-import" ? this.importLabel() : this.busy ? "Working…" : compact && this.values.kind === "epic" && this.p.epic == null ? "Create Epic" : sp.submit, (_e, cx) => this.submit(cx), { primary: true })));
  }
}

// Machine access editor: per machine "Access" and "Sudo" (sudo only where the machine has it on).
export function accessArgs(access) {
  const names = Object.keys(access ?? {});
  const on = names.filter((n) => access[n].on);
  return { machines: on.length === names.length ? "" : on.join(","), sudo: on.filter((n) => access[n].sudo).join(",") };
}
// Risk levels of an agent (agents.json "risk"; hp enforces them): [value, label, one-line meaning, color].
export const RISKS = [
  ["careful", "Careful", "Asks before pushing to main or running risky commands", OK],
  ["balanced", "Balanced", "Asks only on production machines", "#8aa4c8"],
  ["autonomous", "Autonomous", "Deploys and merges on its own", WARN],
];
export const riskOf = (a) => (RISKS.some((r) => r[0] === a?.risk) ? a.risk : "balanced");
// Text segmented control, 28 px. choices: [[value, label]]; onPick(cx, value).
// dots: { value: color } puts a status dot before the selected label; tips: { value: tooltip }.
export function segmented(t, id, choices, value, onPick, { dots = null, tips = null, compact = false } = {}) {
  return h_flex().id(id).flex_none().h(T.h.btn).p(T.sp.xxs).gap(T.sp.xxs).rounded(T.r.ctrl).items_center().bg(t.raised)
    .children(choices.map(([val, text]) => {
      const on = value === val;
      return h_flex().id(`${id}-${val || "none"}`).h(T.h.btn - 2 * T.sp.xxs).px(compact ? T.sp.sm : T.sp.md).gap(T.sp.sm).rounded(T.r.chip).items_center().cursor_pointer()
        .text_size(T.text.xs).font_medium().text_color(on ? t.foreground : t.muted).bg(on ? t.background : clear)
        .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
        .when(Boolean(tips?.[val]), (el) => el.tooltip(tips[val]))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { if (!on) onPick(cx, val); })
        .when(Boolean(on && dots?.[val]), (el) => el.child(div().size(T.dot).rounded_full().bg(dots[val])))
        .child(text);
    }));
}
// Risk switch (agent detail header): short labels, the meaning as a tooltip. onPick(cx, value).
export function riskSeg(t, id, value, onPick) {
  return segmented(t, id, RISKS.map((r) => [r[0], r[1]]), value, onPick,
    { dots: Object.fromEntries(RISKS.map((r) => [r[0], r[3]])), tips: Object.fromEntries(RISKS.map((r) => [r[0], r[2]])) });
}
export function switchEl(t, id, on, onToggle, disabled) {
  return h_flex().id(id).flex_none().w(34).h(20).rounded(T.r.panel).p(2).cursor_pointer().items_center()
    .bg(on ? t.accent : t.input).when(Boolean(disabled), (el) => el.opacity(0.4))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { if (!disabled) onToggle(cx); })
    .child(div().size(16).rounded_full().bg(on ? t.accent_foreground : t.surface).when(on, (el) => el.ml(12)));
}
export function accessEditor(t, access, machines, idp, onChange, { q = "", search = null } = {}) {
  const names = Object.keys(access);
  if (!names.length) return div().text_size(T.text.xs).text_color(t.dim).child("This project has no machines yet.");
  const on = names.filter((n) => access[n].on).length;
  const shown = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  const setAll = (v, cx) => { for (const n of shown) { access[n].on = v; if (!v) access[n].sudo = false; } onChange?.(cx); cx.notify(); };
  const link = (id, text, v) => div().id(id).cursor_pointer().text_size(T.text.xs).text_color(t.accent).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => setAll(v, cx)).child(text);
  const rows = shown.map((n) => {
    const i = names.indexOf(n);
      const a = access[n];
      const m = (machines ?? []).find((x) => x.name === n);
      const sudoAvail = Boolean(m?.sudo);
      return h_flex().id(`${idp}-${i}`).flex_none().h(36).px(12).gap(8).items_center().border_t_1().border_color(t.border).tooltip(n)
        .child(tile(n, { kind: "vm", size: 18 }))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(a.on ? t.foreground : t.muted).child(n))
        .child(div().w(46).flex_none().child(switchEl(t, `${idp}-on-${i}`, a.on, (cx) => { a.on = !a.on; if (!a.on) a.sudo = false; onChange?.(cx); cx.notify(); })))
        .child(div().w(36).flex_none().tooltip(sudoAvail ? "Let this agent use sudo here" : "Sudo is off for this machine")
          .child(switchEl(t, `${idp}-su-${i}`, a.sudo, (cx) => { a.sudo = !a.sudo; if (a.sudo) a.on = true; onChange?.(cx); cx.notify(); }, !sudoAvail)));
    });
  // Many machines: the rows scroll in a fixed-height box (the dialog keeps its buttons on screen).
  return v_flex().rounded(T.r.panel).border_1().border_color(t.border).overflow_hidden()
    .when(Boolean(search), (el) => el.child(h_flex().flex_none().p(T.sp.sm).gap(T.sp.md).items_center().bg(t.raised).child(search)))
    .child(h_flex().flex_none().h(28).px(12).gap(8).items_center().bg(t.raised).text_size(T.text.xs).text_color(t.dim)
      .child(div().flex_1().child(`Machine · ${on} of ${names.length}`))
      .when(names.length > 8, (el) => el.child(link(`${idp}-all`, "All", true)).child(link(`${idp}-none`, "None", false)))
      .child(div().w(46).flex_none().child("Access")).child(div().w(36).flex_none().child("Sudo")))
    .child(!rows.length ? h_flex().h(36).px(12).items_center().text_size(T.text.sm).text_color(t.dim).child("No matches")
      : names.length > 8 ? scrollY(`${idp}-scroll`, v_flex().max_h(36 * 8).children(rows), { grow: false }) : v_flex().children(rows));
}
