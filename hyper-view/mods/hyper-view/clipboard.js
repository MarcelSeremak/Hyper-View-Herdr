// Clipboard: your own notes, prompts and snippets. Stored in ~/.herdr/clipboard.json
// (outside the layout folder, so sharing the layout never shares your notes).
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile } from "herdr";
import { DEMO_CLIPS } from "./demo.js";
import { relTime, emptyLine, trackHover, hovered, kbd } from "./ide.js";
import { demo, herdrHome, b64, button, iconButton, card, grid, toast, fmtDate, iconEl } from "./lib.js";

const file = () => `${herdrHome()}/clipboard.json`;

export async function loadClips(real = false) {
  if (demo() && !real) return { text: null, items: DEMO_CLIPS };
  const text = await readTextFile(file()).catch(() => null);
  try { return { text, items: text ? JSON.parse(text.replace(/^﻿/, "")).items ?? [] : [] }; } catch { return { text, items: [] }; }
}

// Read-modify-write with the snapshot check writeTextFile gives us.
export async function changeClips(fn) {
  for (let i = 0; i < 3; i++) {
    const { text, items } = await loadClips(true); // always the real file, also in demo mode
    const next = fn(items.slice());
    try { await writeTextFile(file(), JSON.stringify({ items: next }, null, 2), text ?? null); return true; } catch {}
  }
  return false;
}

export async function copyText(text) {
  const script = `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))`;
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000 }).catch(() => null);
  return r?.code === 0;
}

const KIND_STYLE = { prompt: ["#8aa4c8", "bot"], note: ["#d4a35a", "list"], command: ["#79b8b0", "terminal"], link: ["#6f9fd0", "globe"] };

export function clipboardView(ws, t, openForm) {
  const items = ws.clips ?? [];
  const q = (ws.clipQ ?? "").toLowerCase();
  const shown = items.filter((c) => !q || `${c.title} ${c.text}`.toLowerCase().includes(q)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)));
  const cardFor = (c) => {
    const glyph = (KIND_STYLE[c.kind] ?? KIND_STYLE.note)[1];
    const rmId = `mp-clip-rm-${c.id}`;
    // One flat card: title row (muted kind icon inline, meta as " · " text), a clipped text preview
    // (no inner box), then Copy on the left and the quiet Edit / Delete on the right.
    const hot = hovered("clip", c.id) || ws.confirm === rmId;
    return trackHover(card(t, `mp-clip-${c.id}`).w_full().px(T.pad.card).py(T.sp.md).gap(T.sp.sm), "clip", c.id)
      .child(h_flex().h(T.h.icon).gap(T.sp.md).items_center()
        .child(iconEl(glyph, t.dim, T.icon.row))
        .child(div().flex_1().min_w(0).text_size(T.text.sm).font_medium().truncate().child(c.title || "Untitled"))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(c.kind ?? "note"))
        .child(relTime(t, `mp-clip-ts-${c.id}`, c.updated))
        .child(iconButton(t, `mp-clip-pin-${c.id}`, "pin", (_e, cx) => ws.clipChange(cx, (all) => all.map((x) => (x.id === c.id ? { ...x, pinned: !x.pinned } : x))),
          c.pinned ? "Unpin" : "Pin to top", { color: c.pinned ? t.accent : t.dim })))
      .child(div().h(T.lh.sm * 3).overflow_hidden()
        .text_size(T.text.sm).line_height(`${T.lh.sm}px`).whitespace_normal().text_color(t.muted)
        .when(c.kind === "command", (el) => el.font_family("JetBrains Mono").text_size(T.text.xs))
        .child(c.text))
      // Copy is the primary action (Enter); Edit / Delete are icon buttons shown on hover.
      .child(h_flex().h(T.h.btnSm).gap(T.sp.xs).items_center()
        .child(button(t, `mp-clip-copy-${c.id}`, "Copy", (_e, cx) => cx.spawn(async () => toast((await copyText(c.text)) ? "Copied" : "Copy failed", c.title, "success")), { small: true, iconName: "copy" }))
        .when(hot, (el) => el.child(kbd(t, "Enter")))
        .child(div().flex_1())
        .when(hot, (el) => el
          .child(iconButton(t, `mp-clip-edit-${c.id}`, "pencil", () => openForm("snippet", { edit: c }), "Edit (E)"))
          .child(ws.confirm === rmId
            ? ws.confirmButton(t, rmId, "Delete", (_e, cx) => ws.clipChange(cx, (all) => all.filter((x) => x.id !== c.id)), { small: true, ghost: true })
            : iconButton(t, rmId, "x", (_e, cx) => { ws.confirm = rmId; cx.notify(); cx.timer.after(3000, (cx) => { if (ws.confirm === rmId) { ws.confirm = null; cx.notify(); } }); }, "Delete"))));
  };
  return v_flex().gap(T.sp.xl)
    .when(items.length === 0, (el) => el.child(emptyLine(t, "mp-clip-new", "Nothing saved yet.", ["New snippet", () => openForm("snippet", {})])))
    .when(items.length > 0 && shown.length === 0, (el) => el.child(emptyLine(t, "mp-clip-none", "No matches.")))
    // Keyboard (workspace.js navMark): Enter copies, E edits, P pins.
    .when(shown.length > 0, (el) => el.child(grid("mp-clip-grid", shown.map((c) => ws.navMark(cardFor(c), {
      key: `clip:${c.id}`,
      open: () => copyText(c.text).then((ok) => toast(ok ? "Copied" : "Copy failed", c.title, ok ? "success" : "error")),
      keys: { e: () => openForm("snippet", { edit: c }), p: (cx) => ws.clipChange(cx, (all) => all.map((x) => (x.id === c.id ? { ...x, pinned: !x.pinned } : x))) },
    }, true)), ws.contentW(), { min: 320, gap: T.sp.md })));
}
