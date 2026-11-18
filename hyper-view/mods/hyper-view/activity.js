// Agent activity from the agents' own session logs: Claude Code transcripts
// (~/.claude/projects/<cwd with non-alphanumerics as '-'>/*.jsonl) and Codex rollouts
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl whose session_meta cwd is the project folder).
//
// Every ~5 s while the center view is shown, activity.ps1 lists those files and returns only the bytes
// appended since the last read (the app has no stat/seek API); this module parses the new lines into:
//   items   timeline events per agent (prompt, read, edit, write, bash, test, search, web, mcp, agent,
//           error, compact, commit), with duration and outcome when the tool result arrives
//   days    tokens per local day, per agent and provider ([input, output, cache read, cache write])
//   models  tokens per agent and model; tools: tool use counts; errors per day
// Sessions are attributed to agents by the first prompt (startAgent writes `You are agent "<name>"`).
// A bounded summary is kept per project in ~/.herdr/projects/<slug>/activity-cache.json, so a restart
// continues from the saved offsets instead of reading every log again.
import { exec, appHome, agents, window as win } from "herdr";
import * as fs from "fs/promises";
import { demo, projectDir, readJson, centerShown, view, MOD, repeat } from "./lib.js";
import { demoActivity } from "./demo.js";

const MAX_ITEMS = 2000, KEEP_DAYS = 400, SHORT_DAYS = 60, CAP = 6 * 1024 * 1024, VER = 1;
const genDir = () => `${String(appHome()).replace(/\\/g, "/")}/mods/${MOD}/.gen`;
const helper = () => `${String(appHome()).replace(/\\/g, "/")}/mods/${MOD}/activity.ps1`;
const winPath = (p) => String(p).replace(/\//g, "\\");
const A = (globalThis.__hvActivity ??= { P: {}, seen: null, busy: 0, lastFull: 0, polls: 0, err: null, ver: 0, savedAt: {}, dirty: {}, dirs: {}, agents: {} });

// ------------------------------------------------------------ helpers
const pad = (n) => String(n).padStart(2, "0");
export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clip = (s, n = 90) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const firstLine = (s) => String(s ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
export function shortPath(p) {
  const parts = String(p ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
}
const AGENT_RX = /You are agent "([A-Za-z0-9][A-Za-z0-9_.-]*)"/;
const TEST_RX = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|jest|vitest|mocha|phpunit|rspec|ctest)\b|\bplaywright\s+test\b|\bcypress\s+run\b|\b(cargo|go|dotnet|mvn|gradle|mix|deno|swift)\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\bmake\s+(test|check)\b|Invoke-Pester/i;
const GIT_RX = /\bgit\s+(?:-C\s+\S+\s+|\S+\s+)?(commit|push)\b/;
const SEARCH_RX = /^(rg|grep|egrep|findstr|select-string|sls|fd|find|ag|ack)\b/i;
const READ_RX = /^(cat|head|tail|less|more|nl|bat|type|get-content|gc)\b|^sed\s+-n\b/i;
// The start prompt (lib.js startAgent) reads as "Session started: <goal>".
function promptLabel(text) {
  if (!AGENT_RX.test(text)) return clip(text, 120);
  const goal = text.match(/Task from the human:\s*([\s\S]+)$/)?.[1];
  return clip(goal ? `Session started: ${goal}` : "Session started", 120);
}
const sum4 = (a, b) => { for (let i = 0; i < 4; i++) a[i] += b[i] || 0; return a; };
const total4 = (a) => (a ? a[0] + a[1] + a[2] + a[3] : 0);

function newProject() { return { v: VER, files: {}, items: [], days: {}, models: {}, tools: {}, toolDays: {}, errors: {}, sessions: {} }; }

// Text of a tool result / message content (string, or blocks with text).
function textOf(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? (typeof b?.content === "string" ? b.content : ""))).join("\n");
  return typeof c.text === "string" ? c.text : "";
}
// "47 passed, 2 failed" from test runner output (the summary is near the end).
function testSummary(out) {
  const s = String(out ?? "").slice(-6000);
  const last = (rx) => { let m, v = null; rx.lastIndex = 0; while ((m = rx.exec(s))) v = Number(m[1] ?? m[2]); return v; };
  const passed = last(/(\d+)\s+(?:passed|passing)\b|Passed:\s*(\d+)/gi);
  const failed = last(/(\d+)\s+(?:failed|failing)\b|Failed:\s*(\d+)/gi);
  if (passed == null && failed == null) return null;
  return { passed: passed ?? 0, failed: failed ?? 0 };
}
// Shell command -> [kind, label]
function shellKind(cmd) {
  const c = String(cmd ?? "").trim();
  const line = firstLine(c);
  const core = line.replace(/^(cd\s+("[^"]*"|\S+)\s*(&&|;)\s*)+/i, "").trim();
  if (TEST_RX.test(c)) return ["test", `Test: ${clip(core, 70)}`];
  const g = c.match(GIT_RX);
  if (g) {
    if (g[1] === "push") return ["commit", "Git push"];
    const m = c.match(/-m\s+(?:"([^"]+)"|'([^']+)')/) ?? c.match(/<<\s*'?EOF'?\s*\n\s*([^\n]+)/);
    const msg = m ? (m[1] ?? m[2] ?? "") : "";
    return ["commit", msg && !msg.startsWith("$(") ? `Commit: ${clip(msg, 70)}` : "Commit"];
  }
  if (SEARCH_RX.test(core)) return ["search", clip(core, 80)];
  if (READ_RX.test(core)) return ["read", clip(core, 80)];
  return ["bash", `Bash: ${clip(core, 80)}`];
}
// Files of an apply_patch text -> [kind, label]
function patchKind(text) {
  const files = [...String(text ?? "").matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)];
  if (!files.length) return ["edit", "Edit (patch)"];
  const [, op, path] = files[0];
  const more = files.length > 1 ? ` (+${files.length - 1})` : "";
  return op === "Add" ? ["write", `Write ${shortPath(path)}${more}`] : op === "Delete" ? ["edit", `Delete ${shortPath(path)}${more}`] : ["edit", `Edit ${shortPath(path)}${more}`];
}
// Claude Code tool_use -> [kind, label] (null = not shown)
function claudeTool(name, input = {}) {
  const fp = input.file_path ?? input.notebook_path ?? input.path ?? "";
  switch (name) {
    case "Read": return ["read", `Read ${shortPath(fp)}`];
    case "Edit": return ["edit", `Edit ${shortPath(fp)}`];
    case "MultiEdit": return ["edit", `Edit ${shortPath(fp)}${Array.isArray(input.edits) ? ` (${input.edits.length} changes)` : ""}`];
    case "NotebookEdit": return ["edit", `Edit ${shortPath(fp)}`];
    case "Write": return ["write", `Write ${shortPath(fp)}`];
    case "Bash": case "PowerShell": return shellKind(input.command);
    case "BashOutput": case "KillShell": case "KillBash": return null;
    case "Grep": return ["search", `Grep "${clip(input.pattern, 50)}"${input.path ? ` in ${shortPath(input.path)}` : ""}`];
    case "Glob": return ["search", `Glob ${clip(input.pattern, 60)}`];
    case "LS": return ["search", `List ${shortPath(fp)}`];
    case "WebFetch": return ["web", `Fetch ${clip(String(input.url ?? "").replace(/^https?:\/\//, ""), 70)}`];
    case "WebSearch": return ["web", `Web search: ${clip(input.query, 70)}`];
    case "Task": case "Agent": return ["agent", `Subagent: ${clip(input.description ?? input.subagent_type ?? "", 70)}`];
    case "TodoWrite": case "ExitPlanMode": case "EnterPlanMode": return null;
  }
  if (name?.startsWith("mcp__")) { const [, server, tool] = name.split("__"); return ["mcp", `MCP ${server}: ${tool ?? ""}`]; }
  return ["tool", String(name ?? "tool")];
}
// Codex function_call -> [kind, label]
function codexTool(name, args) {
  let a = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = { raw: a }; } }
  a ??= {};
  if (["shell", "shell_command", "exec_command", "local_shell", "container.exec", "unified_exec"].includes(name)) {
    let cmd = a.command ?? a.cmd ?? a.raw ?? "";
    if (Array.isArray(cmd)) {
      if (cmd[0] === "apply_patch") return patchKind(cmd[1]);
      const bin = String(cmd[0] ?? "").split(/[\\/]/).pop().toLowerCase();
      cmd = cmd.length >= 2 && /^(bash|sh|zsh|pwsh(\.exe)?|powershell(\.exe)?|cmd(\.exe)?)$/.test(bin) ? cmd[cmd.length - 1] : cmd.join(" ");
    }
    if (/^\s*apply_patch\b/.test(cmd)) return patchKind(cmd);
    return shellKind(cmd);
  }
  if (name === "apply_patch") return patchKind(a.input ?? a.patch ?? a.raw);
  if (name === "update_plan") return null;
  if (name === "view_image") return ["read", `View ${shortPath(a.path)}`];
  if (name === "web_search") return ["web", `Web search: ${clip(a.query, 70)}`];
  if (String(name).includes("__") || String(name).includes(".")) return ["mcp", `MCP ${String(name).replace(/__/, ": ")}`];
  return ["tool", String(name ?? "tool")];
}
// Codex tool output: exit code, duration and text.
function codexOutput(out) {
  let o = out, text = "", code = null, dur = null;
  if (typeof o === "string") {
    try { const j = JSON.parse(o); if (j && typeof j === "object") o = j; } catch {}
  }
  if (typeof o === "string") {
    text = o;
    const m = o.match(/(?:Exit code|exited with code)[:\s]+(-?\d+)/i); if (m) code = Number(m[1]);
    const w = o.match(/Wall time[:\s]+([\d.]+)\s*s/i); if (w) dur = Number(w[1]) * 1000;
  } else if (o && typeof o === "object") {
    text = typeof o.output === "string" ? o.output : textOf(o.content);
    if (o.metadata) { code = o.metadata.exit_code ?? null; if (o.metadata.duration_seconds != null) dur = o.metadata.duration_seconds * 1000; }
    const m = text.match(/^Exit code:\s*(-?\d+)/m); if (code == null && m) code = Number(m[1]);
  }
  return { text, code, dur };
}

// ------------------------------------------------------------ ingestion
function agentOf(P, f) {
  if (f.agent) return f.agent;
  if (f.parent) { const par = Object.values(P.files).find((x) => x.sid === f.parent && x.agent); if (par) return (f.agent = par.agent); }
  const list = A.agents[f.slug] ?? [];
  return list.length === 1 ? list[0] : "unknown";
}
function push(P, f, item) {
  item.a = agentOf(P, f);
  item.s = f.sid ?? "";
  P.items.push(item);
  P.sessions[item.s] ??= { a: item.a, prov: f.prov, model: f.model ?? null, first: item.t };
  P.sessions[item.s].last = item.t;
  if (f.model) P.sessions[item.s].model = f.model;
  return item;
}
function countTool(P, agent, name, t) {
  const by = (P.tools[agent] ??= {});
  by[name] = (by[name] ?? 0) + 1;
  const d = (P.toolDays[dayOf(t)] ??= {});
  d[name] = (d[name] ?? 0) + 1;
}
function countError(P, agent, t) {
  const d = (P.errors[dayOf(t)] ??= {});
  d[agent] = (d[agent] ?? 0) + 1;
}
function addTokens(P, f, t, v, model) {
  if (!total4(v)) return;
  const agent = agentOf(P, f);
  const day = (P.days[dayOf(t)] ??= {});
  sum4((day[`${agent}\t${f.prov}`] ??= [0, 0, 0, 0]), v);
  if (model) sum4(((P.models[agent] ??= {})[model] ??= [0, 0, 0, 0]), v);
}
function finish(P, f, item, { error, out, dur, t }) {
  if (!item) return;
  item.d = dur ?? (t && item.t ? Math.max(0, t - item.t) : undefined);
  item.x = error ? "fail" : "ok";
  if (item.k === "test") {
    const sm = testSummary(out);
    if (sm) { item.l = `${item.l} → ${sm.failed ? `${sm.failed} failed, ` : ""}${sm.passed} passed`; if (sm.failed) item.x = "fail"; }
  }
  if (item.x === "fail" && !["search", "read"].includes(item.k)) countError(P, item.a, item.t);
  if (f.pending && item._pid) delete f.pending[item._pid];
  delete item._pid; delete item._f;
}
// Codex tools are counted under the same names as Claude Code's, so the breakdown reads as one list.
const KIND_TOOL = { bash: "Bash", test: "Bash", commit: "Bash", read: "Read", search: "Grep", edit: "Edit", write: "Write", web: "WebSearch", mcp: "MCP" };
function startTool(P, f, t, kl, id, name) {
  if (!kl) return;
  const item = push(P, f, { t, k: kl[0], l: kl[1], x: "run" });
  countTool(P, item.a, f.prov === "codex" ? KIND_TOOL[kl[0]] ?? name : name, t);
  if (id) {
    item._pid = id;
    const pend = (f.pending ??= {});
    pend[id] = item;
    // Tool calls that never got a result (interrupted sessions) must not pile up: keep the newest 100.
    const ids = Object.keys(pend);
    if (ids.length > 100) for (const k of ids.slice(0, ids.length - 100)) delete pend[k];
  }
}

function claudeLine(P, f, j) {
  const t = Date.parse(j.timestamp);
  if (!Number.isFinite(t)) return;
  if (j.sessionId && !f.sid) f.sid = j.sessionId;
  if (j.type === "user" && j.message) {
    const c = j.message.content;
    if (typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text"))) {
      const text = typeof c === "string" ? c : c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
      if (!f.agent && !j.isSidechain) { const m = text.match(AGENT_RX); if (m) f.agent = m[1]; }
      if (j.isMeta || j.isCompactSummary || j.isSidechain) return;
      const cmd = text.match(/<command-name>([^<]+)<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/);
      if (cmd) { if (!/^\/?(clear|exit)$/.test(cmd[1].trim())) push(P, f, { t, k: "prompt", l: clip(`${cmd[1].trim()} ${cmd[2] ?? ""}`, 100) }); return; }
      if (/^\s*<(local-command|system-reminder|bash-|user-memory)/.test(text) || /^\[Request interrupted/.test(text) || /^Caveat:/.test(text)) return;
      f.lastPrompt = push(P, f, { t, k: "prompt", l: promptLabel(text) });
      return;
    }
    if (Array.isArray(c)) for (const b of c) {
      if (b?.type !== "tool_result") continue;
      const item = f.pending?.[b.tool_use_id];
      const out = textOf(b.content);
      finish(P, f, item, { error: b.is_error === true, out, t, dur: Number(j.toolUseResult?.durationMs) || undefined });
    }
    return;
  }
  if (j.type === "assistant" && j.message) {
    const m = j.message;
    if (m.model && m.model !== "<synthetic>") f.model = m.model;
    const u = m.usage;
    if (u && m.model !== "<synthetic>") {
      const cur = [u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0];
      const ids = (f.ids ??= {});
      const prev = (m.id && ids[m.id]) || [0, 0, 0, 0];
      const delta = cur.map((v, i) => Math.max(0, v - prev[i]));
      if (m.id) { ids[m.id] = cur.map((v, i) => Math.max(v, prev[i])); const keys = Object.keys(ids); if (keys.length > 40) delete ids[keys[0]]; }
      addTokens(P, f, t, delta, f.model);
    }
    if (j.isApiErrorMessage || j.error) {
      const it = push(P, f, { t, k: "error", l: clip(textOf(m.content) || "API error", 110), x: "fail" });
      countError(P, it.a, t);
      return;
    }
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (b?.type === "tool_use") startTool(P, f, t, claudeTool(b.name, b.input ?? {}), b.id, b.name?.startsWith("mcp__") ? "MCP" : b.name);
    }
    return;
  }
  if (j.type === "system") {
    if (j.subtype === "compact_boundary") {
      const pre = j.compactMetadata?.preTokens;
      push(P, f, { t, k: "compact", l: `Context compacted${j.compactMetadata?.trigger === "auto" ? " (auto)" : ""}${pre ? ` · ${Math.round(pre / 1000)}K tokens` : ""}` });
    } else if (j.subtype === "api_error" || j.level === "error") {
      const msg = j.error?.error?.message ?? j.error?.message ?? j.content ?? "API error";
      const it = push(P, f, { t, k: "error", l: clip(`API error: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, 110), x: "fail" });
      countError(P, it.a, t);
    } else if (j.subtype === "turn_duration" && f.lastPrompt && Number(j.durationMs)) {
      f.lastPrompt.d = Number(j.durationMs);
    }
  }
}

function codexLine(P, f, j) {
  const t = Date.parse(j.timestamp);
  if (!Number.isFinite(t)) return;
  const p = j.payload ?? {};
  if (j.type === "session_meta") { f.sid = p.id ?? f.sid; return; }
  if (j.type === "turn_context") { if (p.model) f.model = p.model; return; }
  if (j.type === "compacted") { push(P, f, { t, k: "compact", l: "Context compacted" }); return; }
  if (j.type === "response_item") {
    switch (p.type) {
      case "message": {
        if (p.role !== "user") return;
        const text = textOf(p.content);
        if (!f.agent) { const m = text.match(AGENT_RX); if (m) f.agent = m[1]; }
        return;
      }
      case "function_call": startTool(P, f, t, codexTool(p.name, p.arguments), p.call_id, codexToolName(p.name, p.arguments)); return;
      case "local_shell_call": startTool(P, f, t, codexTool("local_shell", p.action ?? {}), p.call_id ?? p.id, "shell"); return;
      case "custom_tool_call": startTool(P, f, t, p.name === "apply_patch" ? patchKind(p.input) : codexTool(p.name, p.input), p.call_id, p.name === "apply_patch" ? "apply_patch" : p.name); return;
      case "web_search_call": startTool(P, f, t, ["web", `Web search: ${clip(p.action?.query ?? "", 70)}`], null, "web_search"); return;
      case "function_call_output": case "custom_tool_call_output": case "local_shell_call_output": {
        const item = f.pending?.[p.call_id];
        if (!item) return;
        const o = codexOutput(p.output);
        finish(P, f, item, { error: o.code != null && o.code !== 0, out: o.text, dur: o.dur ?? undefined, t });
        return;
      }
    }
    return;
  }
  if (j.type === "event_msg") {
    switch (p.type) {
      case "user_message": {
        const text = String(p.message ?? "");
        if (!f.agent) { const m = text.match(AGENT_RX); if (m) f.agent = m[1]; }
        if (text.trim()) f.lastPrompt = push(P, f, { t, k: "prompt", l: promptLabel(text) });
        return;
      }
      case "token_count": {
        const tot = p.info?.total_token_usage;
        if (!tot) return;
        const cur = [Number(tot.input_tokens) || 0, Number(tot.cached_input_tokens) || 0, Number(tot.output_tokens) || 0];
        const prev = f.prev ?? [0, 0, 0];
        let d = cur.map((v, i) => v - prev[i]);
        if (d.some((v) => v < 0)) d = cur; // counter restarted
        f.prev = cur;
        addTokens(P, f, t, [Math.max(0, d[0] - d[1]), d[2], d[1], 0], f.model);
        return;
      }
      case "error": case "stream_error": {
        const it = push(P, f, { t, k: "error", l: clip(p.message ?? "Error", 110), x: "fail" });
        countError(P, it.a, t);
        return;
      }
      case "task_complete": if (f.lastPrompt && !f.lastPrompt.d) f.lastPrompt.d = Math.max(0, t - f.lastPrompt.t); return;
    }
  }
}
const codexToolName = (name, args) => {
  if (["shell", "shell_command", "exec_command", "local_shell", "container.exec", "unified_exec"].includes(name)) return "shell";
  return String(name).includes("__") ? "MCP" : name;
};

// One JSONL line of a file.
function ingestLine(P, f, line) {
  if (line.length < 2 || line.charCodeAt(0) !== 123) return; // "{"
  let j;
  try { j = JSON.parse(line); } catch { return; }
  try { if (f.prov === "codex") codexLine(P, f, j); else claudeLine(P, f, j); } catch (e) { A.err = `parse: ${e?.message ?? e}`; }
}
const ingest = (P, f, text) => { for (const line of String(text).split("\n")) ingestLine(P, f, line); };

// ------------------------------------------------------------ cache (per project)
// Mods may write only under ~/.config/herdr-app (fs/promises): the cache lives in this mod's data folder.
// (It used to be ~/.herdr/projects/<slug>/activity-cache.json, which could never be written, so after every
// restart the token counts started from zero and Codex logs already "seen" were never read again.)
const actDir = () => `${String(appHome()).replace(/\\/g, "/").replace(/\/+$/, "")}/data/hyper-view/activity`;
const cachePath = (slug) => `${actDir()}/${slug}.json`;
async function project(slug) {
  if (A.P[slug]) return A.P[slug];
  const c = await readJson(cachePath(slug), null);
  const P = c && c.v === VER ? { ...newProject(), ...c } : newProject();
  // Running tools keep their place in the timeline: re-link them to their files.
  for (const it of P.items) if (it.x === "run" && it._pid && it._f && P.files[it._f]) ((P.files[it._f].pending ??= {})[it._pid] = it);
  A.P[slug] ??= P;
  return A.P[slug];
}
function trim(P) {
  if (P.items.length > MAX_ITEMS) P.items.splice(0, P.items.length - MAX_ITEMS);
  const keep = dayOf(Date.now() - KEEP_DAYS * 86400000), short = dayOf(Date.now() - SHORT_DAYS * 86400000);
  for (const k of Object.keys(P.days)) if (k < keep) delete P.days[k];
  for (const k of Object.keys(P.toolDays)) if (k < short) delete P.toolDays[k];
  for (const k of Object.keys(P.errors)) if (k < short) delete P.errors[k];
  const sids = new Set(P.items.map((x) => x.s));
  const names = Object.keys(P.sessions);
  if (names.length > 300) for (const s of names) if (!sids.has(s)) delete P.sessions[s];
}
async function save(slug) {
  const P = A.P[slug];
  if (!P) return;
  // Pending tool calls remember their file so they can be finished after a restart.
  for (const [path, f] of Object.entries(P.files)) for (const it of Object.values(f.pending ?? {})) it._f = path;
  const files = Object.fromEntries(Object.entries(P.files).map(([k, f]) => [k, { ...f, pending: undefined, lastPrompt: undefined }]));
  const out = { ...P, files };
  await fs.mkdir(actDir(), { recursive: true }).catch(() => {});
  await fs.writeFile(cachePath(slug), JSON.stringify(out)).then(() => { A.savedAt[slug] = Date.now(); A.dirty[slug] = false; }).catch((e) => { A.err = `save: ${e?.message ?? e}`; });
}

// ------------------------------------------------------------ polling
const codexSeenPath = () => `${genDir()}/activity-codex-seen.json`;
function matchCwd(cwd, projects) {
  const n = String(cwd ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  let best = null;
  for (const p of projects) {
    const d = winPath(projectDir(p.slug)).replace(/\\+$/, "").toLowerCase();
    if ((n === d || n.startsWith(`${d}\\`)) && (!best || d.length > best.d.length)) best = { slug: p.slug, d };
  }
  return best?.slug ?? null;
}

async function poll(projects, full) {
  A.seen ??= await readJson(codexSeenPath(), {}) ?? {};
  for (const p of projects) A.agents[p.slug] = (p.agents ?? []).map((a) => a.name);
  const Ps = {};
  for (const p of projects) Ps[p.slug] = await project(p.slug);
  // Codex logs seen earlier whose project lost them (no cache): read them again.
  for (const [path, cwd] of Object.entries(A.seen)) {
    const slug = matchCwd(cwd, projects);
    if (slug && Ps[slug] && !Ps[slug].files[path]) Ps[slug].files[path] = { off: 0, prov: "codex", slug, sid: null };
  }
  const known = [];
  const recent = Date.now() - 3 * 86400000;
  for (const [slug, P] of Object.entries(Ps)) for (const [path, f] of Object.entries(P.files)) {
    if (f.prov === "codex" && !full && (f.mt ?? 0) < recent && f.off > 0) continue;
    known.push({ p: path, off: f.off ?? 0, prov: f.prov, slug });
  }
  const req = { cap: CAP, full, days: KEEP_DAYS, projects: projects.map((p) => ({ slug: p.slug, dir: winPath(projectDir(p.slug)) })), known, seen: Object.keys(A.seen) };
  await fs.mkdir(genDir(), { recursive: true }).catch(() => {});
  const reqPath = `${genDir()}/activity-req.json`, respPath = `${genDir()}/activity-resp.txt`;
  await fs.writeFile(reqPath, JSON.stringify(req));
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winPath(helper()), winPath(reqPath), winPath(respPath)], { timeout: 90000 });
  if (r.code !== 0) { A.err = `helper: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)}`; return { changed: false, more: false }; }
  const text = await fs.readFile(respPath, "utf8");
  let changed = false, more = false, seenNew = false, cur = null;
  const flush = () => {
    if (!cur) return;
    const { f, h } = cur;
    f.off = h.next; f.size = h.size; f.mt = h.mt;
    A.dirty[h.slug] = true;
    cur = null;
  };
  const dirs = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("@@HV")) {
      flush();
      let h;
      try { h = JSON.parse(line.slice(6)); } catch { continue; }
      const tag = line.slice(0, 5);
      if (tag === "@@HVA") {
        const P = Ps[h.slug];
        if (!P) continue;
        let f = P.files[h.p];
        if (!f || h.reset) {
          const parent = h.prov === "claude" ? String(h.p).match(/[\\/]([^\\/]+)[\\/]subagents[\\/]/)?.[1] : null;
          f = P.files[h.p] = { off: 0, prov: h.prov, slug: h.slug, sid: h.prov === "claude" && !parent ? String(h.p).split(/[\\/]/).pop().replace(/\.jsonl$/, "") : null, parent };
        }
        f.slug = h.slug;
        if ((f.off ?? 0) !== h.off) continue; // stale answer: read again next time
        cur = { P, f, h };
      } else if (tag === "@@HVC") {
        A.seen[h.p] = h.cwd; seenNew = true;
        const slug = matchCwd(h.cwd, projects);
        if (slug && Ps[slug] && !Ps[slug].files[h.p]) { Ps[slug].files[h.p] = { off: 0, prov: "codex", slug, sid: null }; more = true; }
      } else if (tag === "@@HVD") { (dirs[h.slug] ??= []).push(h.dir); }
      else if (tag === "@@HVU") { (dirs["(no project)"] ??= []).push(h.dir); }
      else if (tag === "@@HVE") { more = more || Boolean(h.more); }
      continue;
    }
    if (cur && line) { ingestLine(cur.P, cur.f, line); changed = true; }
  }
  flush();
  A.dirs = dirs;
  if (seenNew) await fs.writeFile(codexSeenPath(), JSON.stringify(A.seen)).catch(() => {});
  if (changed) for (const P of Object.values(Ps)) { P.items.sort((a, b) => a.t - b.t); trim(P); }
  return { changed, more };
}

// Debug summary (no log content): .gen/activity-debug.json
async function writeDebug(ms) {
  const out = { at: new Date().toISOString(), ms, polls: A.polls, err: A.err, claudeDirs: A.dirs, projects: {} };
  for (const [slug, P] of Object.entries(A.P)) {
    const days = Object.keys(P.days).sort();
    out.projects[slug] = {
      files: Object.keys(P.files).length, items: P.items.length, days: days.length, firstDay: days[0] ?? null,
      agents: [...new Set(P.items.map((x) => x.a))], today: actTokens(slug, null).today, kinds: P.items.reduce((m, x) => ((m[x.k] = (m[x.k] ?? 0) + 1), m), {}),
    };
  }
  await fs.writeFile(`${genDir()}/activity-debug.json`, JSON.stringify(out, null, 1)).catch(() => {});
}

const visible = () => { const k = view().kind; return centerShown() === "mp-view" && (k === "project" || k === "dashboard"); };
// Started once by the center view. getProjects() returns the project list it already loads.
// The newest caller owns the timer (a reloaded view replaces the old one; state in globalThis may outlive it).
export function startActivity(cx, getProjects) {
  const owner = (A.owner = {});
  A.lastFull = 0;
  const tick = (cx, force) => {
    if (A.owner !== owner || demo()) return;
    if (A.busy && Date.now() - A.busy < 120000) return;
    if (!force && !visible()) return;
    // One PowerShell helper at a time (A.busy), and back off while nothing changes: 5 s, 10 s, 20 s …
    // up to 30 s while an agent runs and the window is active, 2 min otherwise.
    if (!force && A.quietAt) {
      let active = true;
      try { active = win().active !== false; } catch {}
      const cap = active && (agents() ?? []).length ? 30000 : 120000;
      if (Date.now() - A.quietAt < Math.min(cap, 5000 * 2 ** Math.min(4, A.quietN ?? 0))) return;
    }
    const projects = (getProjects() ?? []).filter((p) => p?.slug);
    if (!projects.length) return;
    A.busy = Date.now();
    cx.spawn(async (cx) => {
      const t0 = Date.now();
      let res = { changed: false, more: false };
      const full = Date.now() - A.lastFull > 10 * 60 * 1000;
      try {
        res = await poll(projects, full);
        if (full) A.lastFull = Date.now();
        A.polls++;
        if (res.changed) { A.ver++; A.err = A.err?.startsWith("helper") ? null : A.err; }
        for (const slug of Object.keys(A.P)) if (A.dirty[slug] && (!res.more || Date.now() - (A.savedAt[slug] ?? 0) > 60000) && Date.now() - (A.savedAt[slug] ?? 0) > 30000) await save(slug);
        if (A.polls <= 3 || res.changed || full) await writeDebug(Date.now() - t0);
      } catch (e) { A.err = String(e?.message ?? e); }
      A.busy = 0;
      const quiet = !(res.changed || res.more);
      A.quietAt = quiet ? Date.now() : 0;
      A.quietN = quiet ? (A.quietN ?? 0) + 1 : 0;
      if (res.changed) cx.notify();
      // Backfilling a long history: continue right away instead of waiting for the next tick.
      if (res.more && A.owner === owner && visible()) cx.timer.after(600, (cx) => tick(cx, true));
    });
  };
  cx.timer.after(1500, (cx) => tick(cx, true));
  // The old owner's timer cancels itself (it used to keep ticking, returning early, for ever).
  repeat(cx, 5000, (cx) => tick(cx, false), () => A.owner === owner);
}
export const activityVersion = () => A.ver;
export const activityError = () => A.err;

// ------------------------------------------------------------ queries (UI)
const projOf = (slug) => (demo() ? demoActivity(slug) : A.P[slug] ?? null);
// Timeline items of an agent (or all agents with name null), newest first.
export function actItems(slug, agent) {
  const P = projOf(slug);
  if (!P) return [];
  const out = [];
  for (let i = P.items.length - 1; i >= 0; i--) { const x = P.items[i]; if (!agent || x.a === agent) out.push(x); }
  return out;
}
export function actSession(slug, sid) { return projOf(slug)?.sessions?.[sid] ?? null; }
const VERB = { read: "Reading", edit: "Editing", write: "Writing", search: "Searching", web: "Browsing", mcp: "Using", agent: "Running", tool: "Using", commit: "Committing" };
// What the agent is doing right now: its latest tool call still waiting for a result (fresh).
export function actCurrent(slug, agent) {
  const P = projOf(slug);
  if (!P) return null;
  const now = Date.now();
  for (let i = P.items.length - 1; i >= 0; i--) {
    const x = P.items[i];
    if (x.a !== agent) continue;
    if (now - x.t > 15 * 60 * 1000) return null;
    if (x.x === "run") {
      let text;
      if (x.k === "bash") text = `Running ${x.l.replace(/^Bash:\s*/, "")}`;
      else if (x.k === "test") text = `Running tests: ${x.l.replace(/^Test:\s*/, "")}`;
      else if (x.k === "commit") text = x.l.startsWith("Git push") ? "Pushing to git" : `Committing${x.l.includes(":") ? x.l.slice(x.l.indexOf(":")) : ""}`;
      else if (x.k === "read" && !/^Read /.test(x.l)) text = `Reading: ${x.l}`;
      else if (x.k === "search" && !/^(Grep|Glob|List) /.test(x.l)) text = `Searching: ${x.l}`;
      else text = `${VERB[x.k] ?? "Using"} ${x.l.replace(/^(Read|Edit|Write|Delete|Grep|Glob|List|Fetch|Web search:|Subagent:|MCP)\s*/, "")}`;
      return { text, kind: x.k, t: x.t };
    }
    if (x.k === "prompt") return { text: "Thinking…", kind: "prompt", t: x.t };
    return { text: `Last: ${x.l}`, kind: x.k, t: x.t, done: true };
  }
  return null;
}
// Tokens of an agent (null = whole project): today, last 7 days, total (kept days), per model, per day.
export function actTokens(slug, agent) {
  const P = projOf(slug);
  const res = { today: [0, 0, 0, 0], d7: [0, 0, 0, 0], total: [0, 0, 0, 0], models: {}, byDay: {}, prov: null, errorsToday: 0, has: false };
  if (!P) return res;
  const today = dayOf(Date.now()), week = dayOf(Date.now() - 6 * 86400000);
  for (const [day, by] of Object.entries(P.days)) for (const [key, v] of Object.entries(by)) {
    const [a, prov] = key.split("\t");
    if (agent && a !== agent) continue;
    res.has = true;
    res.prov ??= prov;
    sum4(res.total, v);
    if (day >= week) sum4(res.d7, v);
    if (day === today) sum4(res.today, v);
    sum4((res.byDay[day] ??= [0, 0, 0, 0]), v);
  }
  for (const [a, ms] of Object.entries(P.models)) if (!agent || a === agent) for (const [m, v] of Object.entries(ms)) sum4((res.models[m] ??= [0, 0, 0, 0]), v);
  for (const [a, n] of Object.entries(P.errors[today] ?? {})) if (!agent || a === agent) res.errorsToday += n;
  return res;
}
// Usage in the shape `hp usage` returns (engine, input, output, cache_read, cache_write, sessions), or null.
export function actUsage(slug, agent) {
  const P = projOf(slug);
  if (!P) return null;
  const tk = actTokens(slug, agent);
  if (!tk.has) return null;
  const sessions = Object.values(P.sessions).filter((s) => s.a === agent).length;
  return { engine: tk.prov === "codex" ? "codex" : "claude", input: tk.total[0], output: tk.total[1], cache_read: tk.total[2], cache_write: tk.total[3], sessions };
}
export const actHasData = (slug) => { const P = projOf(slug); return Boolean(P && (Object.keys(P.days).length || P.items.length)); };
// Per-agent usage rows of a project (dashboard).
export function actUsageRows(slug) {
  const P = projOf(slug);
  if (!P) return [];
  const names = new Set();
  for (const by of Object.values(P.days)) for (const key of Object.keys(by)) names.add(key.split("\t")[0]);
  return [...names].map((n) => actUsage(slug, n)).filter(Boolean);
}
// Tokens per day over the last n days across projects, split by provider: [{ day, claude, codex }].
export function actDays(slugs, n = 30) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ day: dayOf(Date.now() - i * 86400000), claude: 0, codex: 0 });
  const idx = Object.fromEntries(out.map((x, i) => [x.day, i]));
  for (const slug of slugs) {
    const P = projOf(slug);
    if (!P) continue;
    for (const [day, by] of Object.entries(P.days)) {
      const i = idx[day];
      if (i == null) continue;
      for (const [key, v] of Object.entries(by)) out[i][key.endsWith("\tcodex") ? "codex" : "claude"] += total4(v);
    }
  }
  return out;
}
// Most used tools over the last n days across projects: [[name, count]].
export function actTools(slugs, n = 30, top = 6) {
  const since = dayOf(Date.now() - (n - 1) * 86400000), m = {};
  for (const slug of slugs) {
    const P = projOf(slug);
    if (!P) continue;
    for (const [day, by] of Object.entries(P.toolDays)) if (day >= since) for (const [k, v] of Object.entries(by)) m[k] = (m[k] ?? 0) + v;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, top);
}
export function actErrorsToday(slugs) {
  const today = dayOf(Date.now());
  let n = 0;
  for (const slug of slugs) for (const v of Object.values(projOf(slug)?.errors?.[today] ?? {})) n += v;
  return n;
}

// Exposed for tests (node): parse lines without the app.
export const _test = { newProject, ingest, actItemsOf: (P) => P.items, claudeTool, codexTool, shellKind, testSummary, patchKind };
