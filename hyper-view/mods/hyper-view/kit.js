// Skills and MCP servers: your own library, attached to agents (project and loose alike).
//   ~/.herdr/skills.json  { skills:  [{ id, name, desc, body, agents: ["<slug>/<agent>"], updated }] }
//   ~/.herdr/mcp.json     { servers: [{ id, name, desc, transport: "stdio"|"http", command, args[], cwd,
//                                       env: [{name,value}], url, headers: [{name,value}], agents[], updated }] }
// Values may hold "${secret:NAME}" (a token from Tokens & Access): hp fills it in when the server starts
// (hp mcp exec|bridge|headers), so token values never land in these files or on a command line.
//
// At agent start (lib.js startAgent → prepareKit) the agent's own kit is written to ~/.herdr/kits/<slug>--<agent>/:
//   Claude Code: .claude/skills/<skill>/SKILL.md (claude --add-dir=<kit>) and mcp.json (--mcp-config=<file>)
//   Codex:       skills/<skill>/SKILL.md (listed in its first message; Codex has no per-session skill folder)
//                and one -c mcp_servers.<name>.* override per server (a data/hyper-view/mcp/<name>.cmd shim).
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { readTextFile, writeTextFile, appHome } from "herdr";
import * as fs from "fs/promises";
import { emptyLine, trackHover, hovered, section } from "./ide.js";
import { demo, herdrHome, hpScript, iconButton, card, grid, toast, iconEl, tile, scrollY } from "./lib.js";
import { relTime } from "./ide.js";
import { switchEl } from "./form.js";
import { DEFAULT_SKILLS } from "./defaultskills.js";

const winPath = (p) => String(p).replace(/\//g, "\\");
// Mods may write files only under ~/.config/herdr-app (fs/promises), so the kits live in this mod's data folder.
const kitRoot = () => `${String(appHome()).replace(/\\/g, "/").replace(/\/+$/, "")}/data/hyper-view`;
export const kitSlug = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "x";
export const agentRef = (slug, name) => `${slug}/${name}`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ------------------------------------------------------------------ storage (same pattern as clipboard.js)
const FILES = { skills: () => `${herdrHome()}/skills.json`, servers: () => `${herdrHome()}/mcp.json` };
const parse = (text) => { try { return text ? JSON.parse(text.replace(/^﻿/, "")) ?? {} : {}; } catch { return null; } };
async function load(key) {
  let text = await readTextFile(FILES[key]()).catch(() => null);
  let obj = parse(text);
  // The skills library gets the bundled skills (defaultskills.js) once ("seeded": true). Skills with the
  // same name are left alone, and deleting a bundled skill later sticks.
  if (key === "skills" && obj && !obj.seeded && !demo()) {
    const have = new Set((obj.skills ?? []).map((x) => x.name));
    const add = DEFAULT_SKILLS.filter((x) => !have.has(x.name)).map((x) => ({ ...x, updated: new Date().toISOString() }));
    const next = { ...obj, skills: [...(obj.skills ?? []), ...add], seeded: true };
    try { await writeTextFile(FILES.skills(), JSON.stringify(next, null, 2), text ?? null); } catch {}
    text = await readTextFile(FILES.skills()).catch(() => null);
    obj = parse(text);
  }
  return { text, obj: obj ?? {}, items: obj?.[key] ?? [] };
}
async function change(key, fn) {
  for (let i = 0; i < 3; i++) {
    const { text, obj, items } = await load(key);
    const next = fn(items.slice());
    try { await writeTextFile(FILES[key](), JSON.stringify({ ...obj, [key]: next }, null, 2), text ?? null); return true; } catch {}
  }
  return false;
}
export const loadSkills = () => load("skills");
export const changeSkills = (fn) => change("skills", fn);
export const loadMcp = () => load("servers");
export const changeMcp = (fn) => change("servers", fn);

// Every agent (project and loose) as a multi-select choice: ["<slug>/<name>", label].
export function agentChoices(projects) {
  return (projects ?? []).flatMap((p) => (p.agents ?? []).map((a) => [agentRef(p.slug, a.name), p.loose ? `${a.name} (loose)` : `${p.name} · ${a.name}`]))
    .sort((x, y) => x[1].localeCompare(y[1]));
}
const refLabel = (projects, ref) => agentChoices(projects).find(([r]) => r === ref)?.[1] ?? ref;

// ------------------------------------------------------------------ SKILL.md
// A pasted SKILL.md (with its own --- frontmatter) is kept as is; otherwise we add name + description.
export function parseSkill(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ""));
  if (!m) return null;
  const get = (k) => (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1])?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return { name: get("name"), desc: get("description"), body: m[2] };
}
const yamlStr = (s) => JSON.stringify(String(s ?? "").replace(/\s+/g, " ").trim()); // JSON strings are valid YAML
export function skillMd(s) {
  const own = parseSkill(s.body);
  if (own) return s.body.replace(/^﻿/, "");
  return `---\nname: ${s.name}\ndescription: ${yamlStr(s.desc || s.name)}\n---\n\n${String(s.body ?? "").trim()}\n`;
}

// ------------------------------------------------------------------ agent start
async function rmTree(dir) {
  let list;
  try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await rmTree(p); else await fs.unlink(p).catch(() => {});
  }
  await fs.rmdir(dir).catch(() => {});
}
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const hasSecretIn = (srv) => /\$\{secret:/.test(srv.url ?? "");

// Writes the agent's kit and returns what to add to its start: { argv: [...], note: "text for its first message" }.
export async function prepareKit(project, agent) {
  if (demo() || !project?.slug || !agent?.name) return { argv: [], note: "" };
  const ref = agentRef(project.slug, agent.name);
  const [sk, mc] = await Promise.all([loadSkills(), loadMcp()]);
  const skills = sk.items.filter((s) => (s.agents ?? []).includes(ref));
  const servers = mc.items.filter((s) => (s.agents ?? []).includes(ref));
  const dir = `${kitRoot()}/kits/${project.slug}--${kitSlug(agent.name)}`;
  // Start clean: a skill or server taken away since the last start must not linger.
  await rmTree(`${dir}/.claude`); await rmTree(`${dir}/skills`);
  await fs.unlink(`${dir}/mcp.json`).catch(() => {});
  const argv = [], notes = [];
  if (!skills.length && !servers.length) return { argv, note: "" };
  await fs.mkdir(dir, { recursive: true });
  const codex = agent.app === "codex";
  const hp = winPath(hpScript());

  for (const s of skills) {
    const sd = codex ? `${dir}/skills/${s.name}` : `${dir}/.claude/skills/${s.name}`;
    await fs.mkdir(sd, { recursive: true });
    await fs.writeFile(`${sd}/SKILL.md`, skillMd(s));
    // Supporting files next to SKILL.md (references, scripts, LICENSE.txt); no paths outside the skill folder.
    for (const [rel, text] of Object.entries(s.files ?? {})) {
      const clean = String(rel).replace(/\\/g, "/").split("/").filter((x) => x && x !== "." && x !== "..").join("/");
      if (!clean || clean.toLowerCase() === "skill.md") continue;
      const full = `${sd}/${clean}`;
      if (clean.includes("/")) await fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(full, String(text ?? ""));
    }
  }
  if (skills.length && !codex) argv.push(`--add-dir=${winPath(dir)}`);
  if (skills.length && codex) {
    notes.push(`Skills attached to you (before doing work a skill covers, read its SKILL.md and follow it): ${skills
      .map((s) => `${s.name}${s.desc ? ` (${s.desc})` : ""}: ${winPath(`${dir}/skills/${s.name}/SKILL.md`)}`).join("; ")}.`);
  }

  if (servers.length && !codex) {
    const mcpServers = {};
    for (const s of servers) {
      if (s.transport === "http" && !hasSecretIn(s)) {
        mcpServers[s.name] = { type: "http", url: s.url,
          ...((s.headers ?? []).length ? { headersHelper: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${hpScript()}" mcp headers ${s.name}` } : {}) };
      } else {
        mcpServers[s.name] = { command: "powershell.exe", args: [...PS, hp, "mcp", s.transport === "http" ? "bridge" : "exec", s.name] };
      }
    }
    await fs.writeFile(`${dir}/mcp.json`, JSON.stringify({ mcpServers }, null, 2));
    argv.push(`--mcp-config=${winPath(`${dir}/mcp.json`)}`);
  }
  if (servers.length && codex) {
    // -c values that are not valid TOML are taken as plain strings: paths and URLs need no quotes.
    await fs.mkdir(`${kitRoot()}/mcp`, { recursive: true });
    for (const s of servers) {
      if (s.transport === "http" && !(s.headers ?? []).length && !hasSecretIn(s)) {
        argv.push("-c", `mcp_servers.${s.name}.url=${s.url}`);
        continue;
      }
      const shim = `${kitRoot()}/mcp/${s.name}.cmd`;
      await fs.writeFile(shim, `@powershell.exe ${PS.join(" ")} "${hp}" mcp ${s.transport === "http" ? "bridge" : "exec"} ${s.name}\r\n`);
      argv.push("-c", `mcp_servers.${s.name}.command=${winPath(shim)}`, "-c", `mcp_servers.${s.name}.startup_timeout_sec=60`);
    }
  }
  return { argv, note: notes.join(" ") };
}

// ------------------------------------------------------------------ MCP catalog (Add from template)
// ${secret} = the token picked in the form (a secret from Tokens & Access).
export const MCP_TEMPLATES = [
  { id: "github", name: "github", title: "GitHub", glyph: "git", color: "#6e7681", desc: "Repos, issues, pull requests (GitHub's hosted server)",
    transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: "Authorization: Bearer ${secret}", secret: true },
  { id: "context7", name: "context7", title: "Context7", glyph: "file-text", color: "#2f8f6e", desc: "Up-to-date library docs and code examples",
    transport: "http", url: "https://mcp.context7.com/mcp", headers: "CONTEXT7_API_KEY: ${secret}", secret: "optional" },
  { id: "sentry", name: "sentry", title: "Sentry", glyph: "alert", color: "#6c5fc7", desc: "Errors and issues (sign in with /mcp in Claude, codex mcp login)",
    transport: "http", url: "https://mcp.sentry.dev/mcp" },
  { id: "playwright", name: "playwright", title: "Playwright", glyph: "globe", color: "#2c8a4a", desc: "Drive a real browser: open pages, click, screenshot",
    transport: "stdio", command: "npx", args: "-y\n@playwright/mcp@latest" },
  { id: "filesystem", name: "filesystem", title: "Filesystem", glyph: "hard-drive", color: "#b07a3a", desc: "Read and write files in the folders you list",
    transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-filesystem\nC:\\code" },
  { id: "memory", name: "memory", title: "Memory", glyph: "brain", color: "#8a6fc0", desc: "A small knowledge graph the agent keeps between sessions",
    transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-memory" },
  { id: "thinking", name: "sequential-thinking", title: "Sequential thinking", glyph: "list", color: "#4f86b8", desc: "Step-by-step reasoning tool",
    transport: "stdio", command: "npx", args: "-y\n@modelcontextprotocol/server-sequential-thinking" },
  { id: "custom-stdio", name: "", title: "Custom (stdio)", glyph: "terminal", color: "#5f6b7a", desc: "A local program: command, arguments, env", transport: "stdio", command: "" },
  { id: "custom-http", name: "", title: "Custom (HTTP)", glyph: "network", color: "#5f6b7a", desc: "A remote server URL, optional headers", transport: "http", url: "" },
];
// Form values ⇄ stored server.
export const pairsToText = (list, sep) => (list ?? []).map((e) => `${e.name}${sep}${e.value}`).join("\n");
export function textToPairs(text, sep) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(sep);
    return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + sep.length).trim() } : null;
  }).filter(Boolean);
}

// ------------------------------------------------------------------ views
const agentsLine = (t, projects, refs) => {
  const n = (refs ?? []).length;
  return h_flex().id(`mp-kit-ag-${(refs ?? []).join(",").slice(0, 60)}`).flex_none().gap(T.sp.xs).items_center()
    .tooltip(n ? refs.map((r) => refLabel(projects, r)).join("\n") : "Not attached to any agent")
    .child(iconEl("users", t.dim, 12))
    .child(div().text_size(T.text.xs).text_color(n ? t.muted : t.dim).child(n ? `${n} agent${n === 1 ? "" : "s"}` : "No agents"));
};
function rowActions(ws, t, id, onEdit, onDelete) {
  const rmId = `${id}-rm`;
  return h_flex().gap(T.sp.xs).items_center()
    .child(iconButton(t, `${id}-edit`, "pencil", () => onEdit(), "Edit (E)"))
    .child(ws.confirm === rmId
      ? ws.confirmButton(t, rmId, "Delete", (_e, cx) => onDelete(cx), { small: true, ghost: true })
      : iconButton(t, rmId, "x", (_e, cx) => { ws.confirm = rmId; cx.notify(); cx.timer.after(3000, (cx) => { if (ws.confirm === rmId) { ws.confirm = null; cx.notify(); } }); }, "Delete"));
}

export function skillsView(ws, t, openForm) {
  const items = ws.skills ?? [];
  const cardFor = (s) => {
    const hot = hovered("skill", s.id) || ws.confirm === `mp-sk-${s.id}-rm`;
    return trackHover(card(t, `mp-sk-${s.id}`).w_full().px(T.pad.card).py(T.sp.md).gap(T.sp.sm), "skill", s.id)
      .child(h_flex().h(T.h.icon).gap(T.sp.md).items_center()
        .child(iconEl("puzzle", t.accent, T.icon.row))
        .child(div().flex_1().min_w(0).text_size(T.text.sm).font_medium().truncate().child(s.name))
        .child(relTime(t, `mp-sk-ts-${s.id}`, s.updated)))
      .child(div().h(T.lh.sm * 2).overflow_hidden().text_size(T.text.sm).line_height(`${T.lh.sm}px`).whitespace_normal()
        .text_color(s.desc ? t.muted : t.dim).child(s.desc || "No description: Claude picks a skill by its description."))
      .child(h_flex().h(T.h.btnSm).gap(T.sp.md).items_center()
        .child(agentsLine(t, ws.projects, s.agents))
        .child(div().flex_1().text_size(T.text.xs).text_color(t.dim).truncate().child(Object.keys(s.files ?? {}).length ? `+${Object.keys(s.files).length} files` : ""))
        .when(hot, (el) => el.child(rowActions(ws, t, `mp-sk-${s.id}`, () => openForm("skill-edit", { edit: s }),
          (cx) => ws.kitChange(cx, "skills", (all) => all.filter((x) => x.id !== s.id))))));
  };
  return v_flex().gap(T.sp.xl)
    .when(items.length === 0, (el) => el.child(emptyLine(t, "mp-sk-new", "No skills yet.", ["New skill", () => openForm("skill-edit", {})])))
    .when(items.length > 0, (el) => el.child(grid("mp-sk-grid", items.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => ws.navMark(cardFor(s), {
      key: `skill:${s.id}`, open: () => openForm("skill-edit", { edit: s }), keys: { e: () => openForm("skill-edit", { edit: s }) },
    }, true)), ws.contentW(), { min: 320, gap: T.sp.md })));
}

export function mcpView(ws, t, openForm) {
  const items = ws.mcp ?? [];
  const cardFor = (s) => {
    const hot = hovered("mcp", s.id) || ws.confirm === `mp-mcp-${s.id}-rm`;
    const where = s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ");
    const secrets = [...new Set([...JSON.stringify([s.env, s.headers, s.url, s.args]).matchAll(/\$\{secret:([^}]+)\}/g)].map((m) => m[1]))];
    return trackHover(card(t, `mp-mcp-${s.id}`).w_full().px(T.pad.card).py(T.sp.md).gap(T.sp.sm), "mcp", s.id)
      .child(h_flex().h(T.h.icon).gap(T.sp.md).items_center()
        .child(iconEl("plug", t.accent, T.icon.row))
        .child(div().flex_1().min_w(0).text_size(T.text.sm).font_medium().truncate().child(s.name))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(s.transport === "http" ? "HTTP" : "stdio")))
      .child(div().text_size(T.text.xs).font_family("JetBrains Mono").text_color(t.muted).truncate().child(where || "—"))
      .child(div().text_size(T.text.sm).text_color(t.dim).truncate().child(s.desc || ""))
      .child(h_flex().h(T.h.btnSm).gap(T.sp.md).items_center()
        .child(agentsLine(t, ws.projects, s.agents))
        .when(secrets.length > 0, (el) => el.child(h_flex().id(`mp-mcp-key-${s.id}`).gap(T.sp.xs).items_center().tooltip(`Tokens: ${secrets.join(", ")}`)
          .child(iconEl("key", t.dim, 12)).child(div().text_size(T.text.xs).text_color(t.muted).child(secrets.join(", ")))))
        .child(div().flex_1())
        .when(hot, (el) => el.child(rowActions(ws, t, `mp-mcp-${s.id}`, () => openForm("mcp-edit", { edit: s }),
          (cx) => ws.kitChange(cx, "servers", (all) => all.filter((x) => x.id !== s.id))))));
  };
  const tpl = (x) => h_flex().id(`mp-mcp-tpl-${x.id}`).w_full().h(52).px(T.sp.md).gap(T.sp.md).items_center().rounded(T.r.panel)
    .bg(t.surface).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click(() => openForm("mcp-edit", { tpl: x }))
    .child(tile(x.title, { glyph: x.glyph, color: x.color, size: 28 }))
    .child(v_flex().flex_1().min_w(0)
      .child(div().text_size(T.text.sm).font_medium().truncate().child(x.title))
      .child(div().text_size(T.text.xs).text_color(t.dim).truncate().child(x.desc)));
  return v_flex().gap(T.sp.xl)
    .child(v_flex().gap(T.sp.sm)
      .child(section(t, "Your servers", { count: items.length || null }))
      .when(items.length === 0, (el) => el.child(card(t, "mp-mcp-empty").child(emptyLine(t, "mp-mcp-new", "No MCP servers yet. Pick one below or", ["add your own", () => openForm("mcp-edit", { tpl: MCP_TEMPLATES.find((x) => x.id === "custom-stdio") })]))))
      .when(items.length > 0, (el) => el.child(grid("mp-mcp-grid", items.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => ws.navMark(cardFor(s), {
        key: `mcp:${s.id}`, open: () => openForm("mcp-edit", { edit: s }), keys: { e: () => openForm("mcp-edit", { edit: s }) },
      }, true)), ws.contentW(), { min: 320, gap: T.sp.md }))))
    .child(v_flex().gap(T.sp.sm)
      .child(section(t, "Add a server"))
      .child(grid("mp-mcp-tpls", MCP_TEMPLATES.map(tpl), ws.contentW(), { min: 260, gap: T.sp.md })));
}

// ------------------------------------------------------------ list panels (agent page, project Credentials)
// One panel = title + count, a search field, then a fixed-height list (6 rows, scrolls past that), so
// panels side by side are always the same height.
export const PANEL_ROWS = 6;
export function searchField(t, id, state, q, onClear, placeholderW) {
  return h_flex().id(id).w_full().h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).bg(t.background).border_1().border_color(q ? t.accent : t.input)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(iconEl("search", t.dim, 12))
    .child(Input.new(state).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground))
    .when(Boolean(q), (el) => el.child(div().id(`${id}-x`).cursor_pointer().text_size(T.text.xs).text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { onClear(cx); cx.notify(); }).child("Clear")));
}
export function listPanel(t, { id, title, count, right, search, rows, empty, rowsVisible = PANEL_ROWS }) {
  const H = T.h.row * rowsVisible;
  return v_flex().flex_1().min_w(0)
    .child(section(t, title, { count, right }))
    .child(card(t, id).overflow_hidden()
      .when(Boolean(search), (el) => el.child(h_flex().flex_none().p(T.sp.sm).border_b_1().border_color(t.border).child(search)))
      .child(v_flex().flex_none().h(H + T.sp.xs * 2).py(T.sp.xs)
        .child(!rows.length ? empty
          : rows.length > rowsVisible ? scrollY(`${id}-scroll`, v_flex().max_h(H).children(rows), { grow: false })
          : v_flex().children(rows))));
}
const match = (q, ...parts) => !q || q.split(/\s+/).every((w) => parts.filter(Boolean).join(" ").toLowerCase().includes(w));

// Agent page: Skills and MCP servers panels (one switch per item; applied at the next start).
export function kitPanels(ws, t, p, a, openForm) {
  const ref = agentRef(p.slug, a.name);
  const block = (key, title, list, glyph, empty, formKind) => {
    const q = ws.agQv?.[key] ?? "";
    const on = list.filter((x) => (x.agents ?? []).includes(ref)).length;
    const rows = list.slice().sort((x, y) => x.name.localeCompare(y.name)).filter((x) => match(q, x.name, x.desc)).map((x, i) => {
      const has = (x.agents ?? []).includes(ref);
      return h_flex().id(`mp-ag-${key}-${x.id ?? i}`).flex_none().h(T.h.row).px(T.pad.card).gap(T.sp.md).items_center().tooltip(x.desc || x.name)
        .child(iconEl(glyph, has ? t.accent : t.dim, 14))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(has ? t.foreground : t.muted).child(x.name))
        .child(h_flex().flex_none().w(52).justify_center()
          .child(switchEl(t, `mp-ag-${key}-sw-${x.id ?? i}`, has, (cx) => ws.kitChange(cx, key, (all) => all.map((y) => (y.id !== x.id ? y
            : { ...y, agents: has ? (y.agents ?? []).filter((r) => r !== ref) : [...(y.agents ?? []), ref] }))))));
    });
    return listPanel(t, { id: `mp-ag-${key}`, title, count: list.length ? `${on} of ${list.length}` : null,
      search: searchField(t, `mp-ag-${key}-q`, ws.agQ(key), q, () => ws.agQClear(key)), rows,
      empty: list.length ? emptyLine(t, `mp-ag-${key}-none`, "No matches.") : emptyLine(t, `mp-ag-${key}-empty`, empty, ["Add one", () => openForm(formKind, {})]) });
  };
  return [block("skills", "Skills", ws.skills ?? [], "puzzle", "No skills yet.", "skill-edit"),
    block("servers", "MCP servers", ws.mcp ?? [], "plug", "No MCP servers yet.", "mcp-edit")];
}

// Saving from the forms (form.js): returns an error text or null.
export async function saveSkill(edit, v, agentsRefs) {
  const own = parseSkill(v.body);
  if (!v.name.trim() && !own?.name) return "Required: Name";
  const name = kitSlug(v.name || own?.name);
  if (!v.body.trim()) return "Required: Prompt";
  const desc = (v.desc || own?.desc || "").trim();
  const { items } = await loadSkills();
  if (items.some((x) => x.name === name && x.id !== edit?.id)) return `A skill named "${name}" already exists.`;
  const item = { ...(edit ?? {}), id: edit?.id ?? newId(), name, desc, body: v.body, agents: agentsRefs ?? [], updated: new Date().toISOString() };
  const ok = await changeSkills((all) => (edit ? all.map((x) => (x.id === edit.id ? item : x)) : [...all, item]));
  if (!ok) return "Could not save (the file changed); try again.";
  toast(edit ? "Skill saved" : "Skill added", item.agents.length ? `${name} · ${item.agents.length} agent(s), applies at their next start` : name, "success");
  return null;
}
export async function saveServer(edit, v, agentsRefs, secretOptional = false) {
  const name = kitSlug(v.name);
  if (!v.name.trim()) return "Required: Name";
  const http = v.transport === "http";
  const fillSecret = (text) => {
    if (!/\$\{secret\}/.test(text)) return text;
    if (v.secret) return text.replace(/\$\{secret\}/g, `\${secret:${v.secret}}`);
    return null;
  };
  let env = textToPairs(v.env, "="), headers = textToPairs(v.headers, ":");
  // "${secret}" (from a template) needs a token; optional ones are dropped when none is picked.
  const resolve = (list) => list.map((e) => ({ ...e, value: fillSecret(e.value) }));
  env = resolve(env); headers = resolve(headers);
  if ([...env, ...headers].some((e) => e.value === null)) {
    if (!secretOptional) return "Pick the token (Tokens & Access) this server needs.";
    env = env.filter((e) => e.value !== null); headers = headers.filter((e) => e.value !== null);
  }
  const args = String(v.args ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => fillSecret(x) ?? x);
  if (http && !/^https?:\/\//.test(v.url.trim())) return "URL must start with https:// (or http://)";
  if (!http && !v.command.trim()) return "Required: Command";
  const { items } = await loadMcp();
  if (items.some((x) => x.name === name && x.id !== edit?.id)) return `A server named "${name}" already exists.`;
  const item = { id: edit?.id ?? newId(), name, desc: v.desc.trim(), transport: http ? "http" : "stdio",
    ...(http ? { url: v.url.trim(), headers } : { command: v.command.trim(), args, env, cwd: v.cwd.trim() }),
    agents: agentsRefs ?? [], updated: new Date().toISOString() };
  const ok = await changeMcp((all) => (edit ? all.map((x) => (x.id === edit.id ? item : x)) : [...all, item]));
  if (!ok) return "Could not save (the file changed); try again.";
  toast(edit ? "MCP server saved" : "MCP server added", item.agents.length ? `${name} · ${item.agents.length} agent(s), applies at their next start` : name, "success");
  return null;
}
