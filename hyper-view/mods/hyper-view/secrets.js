// Tokens & Access (global secrets, usable by every agent) and global Settings.
import { cardHead as cardHeader, colHead, emptyLine, relTime, relShort, trackHover, hovered } from "./ide.js";
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, shared, setShared } from "herdr";
import {
  iconEl, button, card, empty, ago, tile, herdrHome, hpCmd, hp, toast, pill, iconButton, BAD, WARN,
  splitRow, sideCol, clear,
} from "./lib.js";
import { openForm } from "./form.js";
import { typeOf, typeLabel, daysLeft } from "./secretkinds.js";

// Expiry cell: date, amber under 14 days, red when expired.
function expiryEl(t, s) {
  const d = daysLeft(s.expires);
  if (d == null) return div().text_size(T.text.xs).text_color(t.dim).child("No expiry");
  const date = String(s.expires).slice(0, 10);
  if (d < 0) return pill(t, "Expired", BAD);
  if (d < 14) return pill(t, d === 0 ? "Expires today" : `${d} day${d === 1 ? "" : "s"} left`, WARN);
  return div().text_size(T.text.xs).text_color(t.muted).truncate().child(date);
}

export function secretsView(ws, t) {
  const list = ws.secrets.slice().sort((a, b) => a.name.localeCompare(b.name));
  const lastUse = {}, count = {};
  for (const u of ws.uses) { lastUse[u.secret] = u; count[u.secret] = (count[u.secret] ?? 0) + 1; }
  const projName = (slug) => {
    const p = ws.projects.find((x) => x.slug === slug);
    return p ? (p.loose ? p.agents[0]?.name ?? p.name : p.name) : slug;
  };

  // IDE list (VS Code / Zed panels): one 32px line per secret, columns aligned under a quiet header,
  // row actions as icon buttons that appear on hover (keyboard: Enter edits, → actions).
  const W = ws.width, showWhere = W > 980, showUse = W > 820;
  const COLS = [["Name", "grow"], ...(showWhere ? [["Where", 200]] : []), ["Shared with", 180], ["Expires", 110], ...(showUse ? [["Last used", 156]] : []), ["", 52]];
  const row = (s) => {
    const { prov } = typeOf(s);
    const kind = typeLabel(s), color = s.kind === "sudo" ? WARN : prov.color, glyph = s.kind === "sudo" ? "shield" : prov.glyph;
    const where = [String(s.host || s.url || "").replace(/^https?:\/\//, ""), s.user].filter(Boolean).join(" · ");
    const u = lastUse[s.name], n = count[s.name] ?? 0;
    const shared = s.projects.map(projName).join(", ");
    const rm = `mp-sec-rm-${s.name}`;
    const hot = hovered("sec", s.name) || ws.confirm === rm;
    return trackHover(h_flex().id(`mp-sec-${s.name}`).h(T.h.row).px(12).gap(12).items_center().border_t_1().border_color(t.border).hover((st) => st.bg(t.hover)), "sec", s.name)
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(tile(s.name, { size: 16, glyph, color, radius: 4 }))
        .child(div().flex_none().max_w(260).truncate().text_size(T.text.sm).font_medium().child(s.name))
        .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(t.dim).child(kind)))
      .when(showWhere, (el) => el.child(div().w(200).flex_none().min_w(0).truncate().text_size(T.text.xs).text_color(t.muted).child(where || "—")))
      .child(h_flex().id(`mp-sec-sh-${s.name}`).w(180).flex_none().min_w(0).when(Boolean(shared), (el) => el.tooltip(shared))
        .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(s.projects.length ? t.muted : t.dim).child(s.projects.length ? shared : "Not shared")))
      .child(h_flex().id(`mp-sec-ex-${s.name}`).w(110).flex_none().min_w(0).when(Boolean(s.expires), (el) => el.tooltip(`Expires ${String(s.expires).slice(0, 10)}`)).child(expiryEl(t, s)))
      .when(showUse, (el) => el.child(h_flex().w(156).flex_none().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().text_size(T.text.xs).text_color(u ? t.muted : t.dim).child(u ? (u.by === "ty" ? "You" : u.by) : "Never"))
        .when(Boolean(u), (el) => el.child(relTime(t, `mp-sec-u-${s.name}`, u.ts, { text: `${relShort(u.ts)} · ${n}×` })))))
      .child(h_flex().w(52).flex_none().gap(4).justify_end().when(hot, (el) => el
        .child(iconButton(t, `mp-sec-edit-${s.name}`, "pencil", () => openForm("secret-add", { edit: s }), "Edit (Enter)"))
        .child(ws.confirm === rm
          ? iconButton(t, `${rm}-sure`, "x", (_e, cx) => { ws.confirm = null; ws.act(cx, ["secret", "rm", s.name], {}, `Revoked ${s.name}`); }, "Click again to revoke", { color: BAD })
          : iconButton(t, rm, "x", (_e, cx) => { ws.confirm = rm; cx.notify(); cx.timer.after(3000, (cx) => { if (ws.confirm === rm) { ws.confirm = null; cx.notify(); } }); }, "Revoke"))));
  };

  return v_flex().gap(16)
    .child(card(t, "mp-sec-list").overflow_hidden()
      .when(list.length === 0, (el) => el.child(emptyLine(t, "mp-sec-empty", "No secrets yet.", ["Add a secret", () => openForm("secret-add")])))
      .when(list.length > 0, (el) => el.child(colHead(t, COLS, { pl: 12, pr: 12 })))
      // Keyboard (workspace.js navMark): Enter edits, → actions (share, copy name, remove).
      .children(list.map((s, i) => ws.navMark(i === 0 ? row(s).border_t_0() : row(s), { key: `sec:${s.name}`, open: () => openForm("secret-add", { edit: s }), ref: { kind: "secret", name: s.name } }))));
}

function code(t, text) {
  return div().px(12).py(8).rounded(T.r.panel).bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(T.text.sm).font_family("JetBrains Mono").whitespace_normal().child(text);
}

export function settingsView(ws, t) {
  // Segmented control (same as Board / By agent).
  const opt = (id, label, on, onClick) => h_flex().id(id).h(22).px(T.sp.md).rounded(T.r.chip).items_center().cursor_pointer().text_size(T.text.sm).font_medium()
    .bg(on ? t.surface : clear).text_color(on ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground))
    .on_click(onClick).child(label);
  const theme = shared("mp.themePick") ?? "system";
  const pickTheme = (k) => () => {
    setShared("mp.themePick", k);
    if (k === "light") run("app.theme", { name: "hyper-view-light" });
    else if (k === "dark") run("app.theme", { name: "hyper-view-dark" });
    else run("layout.reset", { name: "hyper-view" });
  };
  return v_flex().gap(16)
    .child(card(t, "mp-set-look").child(cardHeader(t, "Appearance"))
      .child(h_flex().px(12).pb(12).child(h_flex().p(2).gap(2).rounded(T.r.ctrl).bg(t.raised).border_1().border_color(t.border)
        .child(opt("mp-set-t-sys", "System", theme === "system", pickTheme("system")))
        .child(opt("mp-set-t-light", "Light", theme === "light", pickTheme("light")))
        .child(opt("mp-set-t-dark", "Dark", theme === "dark", pickTheme("dark"))))))
    .child(card(t, "mp-set-hp").child(cardHeader(t, "Agent command (hp)", button(t, "mp-set-install", "Reinstall", (_e, cx) => {
      cx.spawn(async () => { const r = await hp(["install"]); toast(r.ok ? "hp installed" : "Install failed", r.ok ? r.out : r.err, r.ok ? "success" : "error"); });
    }, { small: true })))
      .child(v_flex().px(12).pb(12)
        .child(ws.metaRow(t, "Command", hpCmd()))
        .child(ws.metaRow(t, "Data", herdrHome()))
        .child(ws.metaRow(t, "Event store", `${herdrHome()}/herdr.db (SQLite)`))
        .child(ws.metaRow(t, "Secrets", "Windows Credential Manager (herdr:*)"))
        .child(ws.metaRow(t, "SSH key", `${herdrHome()}/keys/id_ed25519`))))
    .child(card(t, "mp-set-refresh").child(cardHeader(t, "Monitoring"))
      .child(v_flex().px(12).pb(12)
        .child(ws.metaRow(t, "This computer", "every 5 s"))
        .child(ws.metaRow(t, "Virtual machines", "every 15 s over SSH"))
        .child(ws.metaRow(t, "Projects & chat", "live (file watch)"))))
    .child(card(t, "mp-set-layout").child(cardHeader(t, "Layout"))
      .child(h_flex().px(12).pb(12).gap(8)
        .child(button(t, "mp-set-switch", "Switch Layout", () => run("layout.switch", {}), { small: true, iconName: "layout" }))
        .child(button(t, "mp-set-reset", "Reset Panels", () => { setShared("mp.leftCollapsed", false); setShared("mp.rightCollapsed", false); run("layout.reset", { name: "hyper-view" }); }, { small: true }))));
}
