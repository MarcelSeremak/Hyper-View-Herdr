// Machine import: parses pasted text or a file into rows for the "vm-import" form.
// Formats (auto-detected): CSV with a header, a JSON array, ~/.ssh/config blocks,
// or one `[name] user@host[:port]` per line.
import { exec } from "herdr";

export const IMPORT_PH = "CSV, JSON, ~/.ssh/config or user@host:port lines\nname,host,user,port,password,sudo,os,desc,projects\nweb-01,10.0.1.11,ubuntu,22,secret,yes,Ubuntu 24.04,,shop;api";

export const IMPORT_EXAMPLE = `name,host,user,port,password,sudo,os,desc,projects
web-01,10.0.1.11,ubuntu,22,secret,yes,Ubuntu 24.04,Frontend,shop;api
db-01,10.0.1.20,debian,2222,,no,Debian 12,"Postgres, primary",shop
`;

// Same slug rules as hp (Polish letters mapped, everything else to "-").
const PL = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
export const slugify = (s) => [...String(s).toLowerCase()].map((c) => PL[c] ?? c).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

const ALIAS = { hostname: "host", address: "host", ip: "host", username: "user", login: "user", pass: "password", pw: "password", description: "desc", project: "projects" };
const key = (k) => { const x = String(k).trim().toLowerCase(); return ALIAS[x] ?? x; };
const yes = (v) => /^(1|y|yes|true|on|tak)$/i.test(String(v ?? "").trim());

function csvRows(text, delim) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function fromCsv(text) {
  const first = text.split("\n")[0];
  const delim = first.includes("\t") ? "\t" : first.includes(",") ? "," : ";";
  const [head, ...rows] = csvRows(text, delim);
  const keys = head.map(key);
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function fromSshConfig(text) {
  const out = []; let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "host") {
      const name = v.split(/\s+/).find((x) => !/[*?!]/.test(x));
      cur = name ? { name, host: name } : null;
      if (cur) out.push(cur);
    } else if (k === "match") cur = null;
    else if (cur && k === "hostname") cur.host = v;
    else if (cur && k === "user") cur.user = v;
    else if (cur && k === "port") cur.port = v;
  }
  return out;
}

function fromLines(text) {
  return text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\s+/);
    const target = parts.length > 1 ? parts[1] : parts[0];
    const m = target.match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:@\s]+)(?::(\d+))?$/);
    if (!m) return { _err: `Cannot read "${l}"` };
    return { name: parts.length > 1 ? parts[0] : "", user: m[1] ?? "", host: m[2].replace(/^\[|\]$/g, ""), port: m[3] ?? "" };
  });
}

// Returns { format, rows, error }. Rows: { name, host, user, port, password, sudo, os, desc, projects[], error? }.
export function parseMachines(input) {
  const text = String(input ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { format: "", rows: [], error: "" };
  let format, raw;
  try {
    if (/^[[{]/.test(text)) {
      format = "JSON";
      const j = JSON.parse(text);
      raw = (Array.isArray(j) ? j : Array.isArray(j.machines) ? j.machines : [j])
        .map((o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [key(k), v])));
    } else if (text.split("\n")[0].split(/[,;\t]/).length > 1 && text.split("\n")[0].split(/[,;\t]/).some((c) => key(c.replace(/"/g, "")) === "host")) {
      format = "CSV"; raw = fromCsv(text);
    } else if (/^\s*host\s+\S/im.test(text)) {
      format = "SSH config"; raw = fromSshConfig(text);
    } else {
      format = "Lines"; raw = fromLines(text);
    }
  } catch (e) {
    return { format: format ?? "", rows: [], error: `${format ?? "Input"}: ${String(e?.message ?? e)}` };
  }
  const seen = new Set();
  const rows = raw.map((o) => {
    const host = String(o.host ?? "").trim(), user = String(o.user ?? "").trim();
    const portS = String(o.port ?? "").trim() || "22";
    const projects = Array.isArray(o.projects) ? o.projects.map(String) : String(o.projects ?? "").split(/[;|,]/);
    const r = {
      name: slugify(String(o.name ?? "").trim() || (/^[\d.]+$|:/.test(host) ? host : host.split(".")[0])), host, user, port: portS,
      password: o.password == null ? "" : String(o.password), sudo: typeof o.sudo === "boolean" ? o.sudo : yes(o.sudo),
      os: String(o.os ?? "").trim(), desc: String(o.desc ?? "").trim(), projects: projects.map((x) => x.trim()).filter(Boolean),
    };
    const port = Number(portS);
    if (o._err) r.error = o._err;
    else if (!host) r.error = "No host";
    else if (!user) r.error = "No user";
    else if (!Number.isInteger(port) || port < 1 || port > 65535) r.error = `Bad port ${portS}`;
    else if (seen.has(r.name)) r.error = "Duplicate name";
    seen.add(r.name);
    return r;
  });
  return { format, rows, error: rows.length ? "" : "No machines found" };
}

// Windows file picker (no picker in the mod API). Resolves a path or null.
export async function pickFile() {
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $o=New-Object System.Windows.Forms.Form; $o.TopMost=$true; "
    + "$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Import machines'; $d.Filter='Machines (*.csv;*.json;*.txt;*.conf;config)|*.csv;*.json;*.txt;*.conf;config|All files (*.*)|*.*'; "
    + "if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.FileName) }";
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps], { timeout: 600000 }).catch(() => null);
  const path = (r?.stdout ?? "").trim();
  return path || null;
}
