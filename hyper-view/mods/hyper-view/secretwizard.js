// Add Secret wizard: 1) service tile grid, 2) token type cards, 3) only the fields that type needs.
// Values go straight to hp.ps1 (Windows Credential Manager); metadata to ~/.herdr/secrets.json.
import { T } from "./tokens.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, closeOverlay, exec, setShared } from "herdr";
import { scrollY, hp, toast, iconEl, tile, button, BAD, OK, WARN, INFO, clear, loadSecrets, listProjects } from "./lib.js";
import { PROVIDERS, SECRET_GROUPS, providerOf, typeOf, typeLabel, daysLeft } from "./secretkinds.js";
import { kbd } from "./ide.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isoDay = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const TAG_COLOR = { Recommended: OK, Common: INFO, Retired: BAD };

function typeGlyph(prov, type) {
  const byId = { app: "cpu", deploy: "rocket", trigger: "play", runner: "server", dc: "server", kubeconfig: "wheel", conn: "database", bundle: "file-text" }[type.id];
  if (byId) return byId;
  if (type.secret?.label?.startsWith("Private key")) return "terminal";
  return prov.glyph ?? "key";
}
// Same five columns in every group, so tiles line up across sections.
function rowsN(id, items, n = 5) {
  const out = [];
  for (let r = 0; r * n < items.length; r++) {
    const cells = items.slice(r * n, r * n + n).map((el, i) => v_flex().id(`${id}-c${r}-${i}`).flex_1().flex_basis(0).min_w(0).child(el));
    while (cells.length < n) cells.push(div().id(`${id}-pad${r}-${cells.length}`).flex_1().flex_basis(0));
    out.push(h_flex().id(`${id}-r${r}`).w_full().gap(8).children(cells));
  }
  return v_flex().id(id).w_full().gap(8).children(out);
}
export function openDocs(url) {
  exec("explorer.exe", [url]).catch(() => toast("Could not open the link", url, "error"));
}

export class SecretWizard {
  constructor(p) { this.p = p; }

  init(cx) {
    this.handle = cx.focus_handle();
    this.projects = []; this.secrets = [];
    this.error = ""; this.busy = false; this.focusedKey = null;
    this.share = new Set(this.p.edit?.projects ?? (this.p.project ? [this.p.project] : []));
    this.step = 1;
    // "Shared with": a searchable list of projects (created here, never during render).
    this.shareQ = InputState.new({ placeholder: "Search projects and agents" });
    this.shareQ.on("change", (_e, cx) => { this.shareQv = this.shareQ.value().trim().toLowerCase(); cx.notify(); });
    this.shareQv = "";
    const e = this.p.edit;
    if (e) {
      const { prov, type } = typeOf(e); this.pick(prov, type, e);
      cx.spawn(async (cx) => {
        const r = await hp(["secret", "get", e.name]);
        if (r.ok && !String(this.values.value ?? "").trim()) { this.inputs.value?.set_value(r.out); this.values.value = r.out; }
        cx.notify();
      });
    }
    else if (this.p.provider) {
      // Dev / deep link: { provider, type? } opens a later step directly.
      const prov = providerOf(this.p.provider);
      if (prov) { this.prov = prov; this.step = 2; const type = prov.types.find((x) => x.id === this.p.type) ?? (prov.types.length === 1 ? prov.types[0] : null); if (type) this.pick(prov, type); }
    }
    cx.spawn(async (cx) => {
      this.projects = await listProjects();
      this.secrets = await loadSecrets();
      if (!e && this.step === 3 && !this.nameTouched) this.inputs.name?.set_value(this.suggestName());
      cx.notify();
    });
  }

  close() { closeOverlay(this.p.overlay); }

  suggestName() {
    const base = this.prov.types.length > 1 ? `${this.prov.id}-${this.type.id}` : this.prov.id;
    const taken = new Set(this.secrets.map((s) => s.name));
    let n = base, i = 2;
    while (taken.has(n)) n = `${base}-${i++}`;
    return n;
  }

  input(key, value, ph, { masked = false, multiline = false, rows = 5 } = {}) {
    const st = multiline ? TextareaState.new({ value: value ?? "", placeholder: ph ?? "", rows }) : InputState.new({ value: value ?? "", placeholder: ph ?? "" });
    if (masked) st.set_masked(true);
    st.on("change", (_e, cx) => { this.values[key] = st.value(); if (key === "name") this.nameTouched = true; cx.notify(); });
    if (!multiline) st.on("submit", (_e, cx) => this.submit(cx));
    st.on("focus", (_e, cx) => { this.focusedKey = key; cx.notify(); });
    this.inputs[key] = st;
    this.values[key] = value ?? "";
    return st;
  }

  // Step 3 state for one type (edit: prefilled from the stored metadata).
  pick(prov, type, meta) {
    this.prov = prov; this.type = type; this.step = 3; this.error = "";
    this.inputs = {}; this.values = {}; this.nameTouched = false;
    const f0 = meta?.fields ?? {};
    const pre = (f) => {
      if (!meta) return f.def ?? "";
      if (f.key === "user") return meta.user ?? "";
      if (f.key === "host") return meta.host ?? String(meta.url ?? "").replace(/^https?:\/\//, "");
      return f0[f.key] ?? "";
    };
    this.input("name", meta ? meta.name : this.secrets ? this.suggestName() : "", "gitlab-main"); // editable when editing too (rename)
    for (const f of type.fields) {
      if (f.choices) this.values[f.key] = pre(f) || f.def || f.choices[0][0];
      else this.input(f.key, pre(f), f.ph);
    }
    const s = type.secret ?? { label: "Value" };
    // Shown in plain text (a local app: you see what you saved). Editing: filled with the saved value (init).
    this.input("value", "", meta ? "Loading…" : (s.ph ?? ""), { masked: false, multiline: Boolean(s.multiline), rows: 5 });
    this.input("expires", meta?.expires ?? "", "YYYY-MM-DD");
    this.input("desc", meta?.desc ?? "", "What it is for");
    this.scopes = new Set(meta?.scopes ?? []);
    const first = meta ? this.inputs.value : this.inputs[type.fields.find((f) => !f.choices && !f.def)?.key] ?? this.inputs.value;
    first?.focus();
  }

  visibleFields() {
    return this.type.fields.filter((f) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => this.values[k] === v));
  }

  back(cx) {
    this.error = "";
    if (this.step === 3 && this.prov.types.length > 1) this.step = 2; else this.step = 1;
    cx.notify();
  }

  submit(cx) {
    if (this.step !== 3 || this.busy) return;
    if (this.p.tour) { toast("Tutorial", "Nothing was saved — this was just a demo.", "info"); this.close(); return; }
    const v = (k) => String(this.values[k] ?? "").trim();
    const edit = this.p.edit;
    const name = slug(v("name")) || (edit ? edit.name : "");
    let err = "";
    if (!name) err = "Required: Name";
    else if (name !== edit?.name && this.secrets.some((s) => s.name === name)) err = `A secret named ${name} already exists.`;
    else {
      const miss = this.visibleFields().find((f) => !f.optional && !f.choices && !v(f.key));
      if (miss) err = `Required: ${miss.label}`;
      else if (!edit && !String(this.values.value ?? "").trim()) err = `Required: ${this.type.secret?.label ?? "Value"}`;
      else if (v("expires") && !DATE_RE.test(v("expires"))) err = "Expires: use YYYY-MM-DD";
    }
    if (err) { this.error = err; cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const e = await this.save(name, v);
      this.busy = false;
      if (e) { this.error = e; cx.notify(); return; }
      this.close();
    });
  }

  async save(name, v) {
    const fields = {};
    let host = "", user = "";
    for (const f of this.visibleFields()) {
      const val = f.choices ? this.values[f.key] : v(f.key);
      if (f.key === "host") host = val; else if (f.key === "user") user = val; else if (val) fields[f.key] = val;
    }
    // Rename first (moves the value and every reference), then save the rest under the new name.
    if (this.p.edit && name !== this.p.edit.name) {
      const rn = await hp(["secret", "rename", this.p.edit.name, name]);
      if (!rn.ok) return rn.err;
    }
    const raw = String(this.values.value ?? "");
    const value = this.type.secret?.multiline ? raw.replace(/\r\n/g, "\n").trim() : raw.trim();
    const r = await hp(["secret", "set", name], {
      provider: this.prov.id, type: this.type.id, kind: this.prov.id, host, user,
      fields: JSON.stringify(fields), scopes: [...this.scopes].join(","), expires: this.type.expires ? v("expires") : "",
      desc: v("desc"), value: value || undefined,
    });
    if (!r.ok) return r.err;
    const real = r.out.split(/\r?\n/).pop().trim() || name;
    const had = new Set(this.p.edit?.projects ?? []);
    for (const s of this.share) if (!had.has(s)) await hp(["secret", "share", real], { p: s });
    for (const s of had) if (!this.share.has(s)) await hp(["secret", "unshare", real], { p: s });
    const n = this.share.size;
    setShared("mp.reloadAt", Date.now());
    toast(`Secret ${real} saved`, n ? `Shared with ${n} project${n > 1 ? "s" : ""}` : "Not shared with any project yet", "success");
    return null;
  }

  // ---------------------------------------------------------------- views
  chip(t, id, text, on, onClick, { check = false } = {}) {
    return h_flex().id(id).h(T.h.btnSm).px(8).gap(4).rounded(T.r.ctrl).items_center().cursor_pointer().text_size(T.text.xs).font_medium()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : clear).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .child(text).when(check && on, (el) => el.child(iconEl("check", t.accent, 11)));
  }
  label(t, text, right) {
    return h_flex().pt(T.sp.lg).pb(T.sp.sm).gap(8).items_center()
      .child(div().text_size(T.text.xs).font_medium().text_color(t.muted).child(text))
      .when(Boolean(right), (el) => el.child(div().flex_1()).child(right));
  }
  box(t, key, { multiline = false } = {}) {
    const st = this.inputs[key];
    const el = multiline ? Textarea.new(st) : Input.new(st);
    return el.w_full().when(!multiline, (e) => e.h(T.h.input)).px(T.sp.md).py(multiline ? T.sp.sm : 0).rounded(T.r.ctrl).border_1()
      .border_color(this.focusedKey === key ? t.accent : t.input).bg(t.background).text_size(T.text.sm).text_color(t.foreground)
      .when(multiline, (e) => e.font_family("JetBrains Mono").text_size(T.text.xs));
  }

  providers(t) {
    const tileEl = (p) => v_flex().id(`mp-sw-p-${p.id}`).h(60).px(8).gap(6).items_center().justify_center().rounded(T.r.panel).cursor_pointer()
      .border_1().border_color(t.border).hover((s) => s.border_color(t.input).bg(t.hover))
      .on_click((_e, cx) => {
        this.prov = p; this.error = "";
        if (p.types.length === 1) this.pick(p, p.types[0]); else this.step = 2;
        cx.notify();
      })
      .when(p.types.length > 1, (el) => el.tooltip(p.types.map((x) => x.name).join(" · ")))
      .child(tile(p.name, { size: 22, glyph: p.glyph, color: p.color, radius: 6 }))
      .child(div().max_w_full().text_size(T.text.xs).font_medium().truncate().child(p.name));
    return v_flex().children(SECRET_GROUPS.map(([g, label]) => v_flex()
      .child(div().pt(T.sp.lg).pb(T.sp.sm).text_size(T.text.xs).font_medium().text_color(t.muted).child(label))
      .child(rowsN(`mp-sw-g-${g}`, PROVIDERS.filter((p) => p.group === g).map(tileEl)))));
  }

  types(t) {
    const p = this.prov;
    return v_flex().pt(12).gap(8).children(p.types.map((x) => h_flex().id(`mp-sw-t-${x.id}`).px(12).py(T.sp.md).gap(12).items_center().rounded(T.r.panel).cursor_pointer()
      .border_1().border_color(t.border).hover((s) => s.border_color(t.input).bg(t.hover))
      .when(x.tag === "Retired", (el) => el.opacity(0.7))
      .on_click((_e, cx) => { this.pick(p, x); cx.spawn(async (cx) => { if (!this.nameTouched) this.inputs.name?.set_value(this.suggestName()); cx.notify(); }); cx.notify(); })
      .child(tile(x.name, { size: 22, glyph: typeGlyph(p, x), color: p.color, radius: 6 }))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(T.text.sm).font_semibold().child(x.name))
          .when(Boolean(x.tag), (el) => el.child(div().text_size(T.text.xs).text_color(TAG_COLOR[x.tag] ?? t.accent).child(x.tag))))
        .child(div().text_size(T.text.xs).text_color(t.muted).whitespace_normal().child(x.desc)))
      .child(iconEl("chevron-right", t.dim, 14))));
  }

  fields(t) {
    const p = this.prov, x = this.type, edit = this.p.edit;
    const s = x.secret ?? { label: "Value" };
    const rows = [];
    const field = (f) => {
      const control = f.choices
        ? h_flex().flex_wrap().gap(6).children(f.choices.map(([val, text]) => this.chip(t, `mp-sw-c-${f.key}-${val}`, text, this.values[f.key] === val, () => { this.values[f.key] = val; })))
        : this.box(t, f.key);
      return v_flex().min_w(0).child(this.label(t, f.optional ? `${f.label} (optional)` : f.label)).child(control);
    };
    // Summary line: provider + type, docs link.
    rows.push(h_flex().pt(6).gap(8).items_center()
      .child(tile(p.name, { size: 22, glyph: typeGlyph(p, x), color: p.color, radius: 6 }))
      .child(div().text_size(T.text.sm).font_medium().truncate().child(typeLabel({ provider: p.id, type: x.id })))
      .child(div().flex_1())
      .when(Boolean(x.docs), (el) => el.child(h_flex().id("mp-sw-docs").h(24).px(8).gap(4).rounded(T.r.ctrl).items_center().cursor_pointer()
        .text_size(T.text.xs).text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(x.docs)
        .on_click(() => openDocs(x.docs))
        .child(iconEl("external", null, 12)).child("Where do I get this?"))));
    rows.push(v_flex().child(this.label(t, "Name")).child(this.box(t, "name")));
    const vis = this.visibleFields();
    vis.forEach((f, i) => {
      if (f.join && i > 0 && !vis[i - 1].join) rows[rows.length - 1] = h_flex().gap(8).items_start().child(field(vis[i - 1]).flex_1()).child(field(f).w(f.join).flex_none());
      else rows.push(field(f));
    });
    rows.push(v_flex().child(this.label(t, s.label)).child(this.box(t, "value", { multiline: Boolean(s.multiline) })));
    if (x.scopes) {
      rows.push(v_flex().child(this.label(t, `${x.scopes.label} (notes only — not enforced)`))
        .child(h_flex().flex_wrap().gap(4).children(x.scopes.list.map((sc) => this.chip(t, `mp-sw-s-${sc}`, sc, this.scopes.has(sc), () => {
          if (this.scopes.has(sc)) this.scopes.delete(sc); else this.scopes.add(sc);
        }, { check: true })))));
    }
    if (x.expires) {
      const ex = String(this.values.expires ?? "").trim();
      const d = DATE_RE.test(ex) ? daysLeft(ex) : null;
      const quick = (id, text, val) => this.chip(t, `mp-sw-x-${id}`, text, ex === val, () => { this.inputs.expires.set_value(val); this.values.expires = val; });
      rows.push(v_flex().child(this.label(t, "Expires (optional)", d == null ? null
        : div().text_size(T.text.xs).text_color(d < 0 ? BAD : d < 14 ? WARN : t.dim).child(d < 0 ? "already expired" : `in ${d} day${d === 1 ? "" : "s"}`)))
        .child(h_flex().gap(6).items_center()
          .child(div().w(130).flex_none().child(this.box(t, "expires")))
          .child(quick("30", "30 days", isoDay(30))).child(quick("90", "90 days", isoDay(90))).child(quick("365", "1 year", isoDay(365)))
          .child(quick("never", "Never", ""))));
    }
    rows.push(v_flex().child(this.label(t, "Notes (optional)")).child(this.box(t, "desc")));
    const projs = [...this.projects.filter((q) => !q.loose), ...this.projects.filter((q) => q.loose)];
    const qv = this.shareQv ?? "";
    const nameOf = (q) => (q.loose ? `${q.agents[0]?.name ?? q.name}` : q.name);
    const shown = projs.filter((q) => !qv || `${nameOf(q)} ${q.slug} ${q.loose ? "agent loose" : "project"}`.toLowerCase().includes(qv));
    const shareRow = (q) => {
      const on = this.share.has(q.slug);
      return h_flex().id(`mp-sw-sh-${q.slug}`).flex_none().h(28).px(T.sp.md).gap(T.sp.md).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { if (on) this.share.delete(q.slug); else this.share.add(q.slug); cx.notify(); })
        .child(h_flex().flex_none().size(14).rounded(3).items_center().justify_center().border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : clear)
          .when(on, (el) => el.child(iconEl("check", t.accent_foreground ?? "#ffffff", 10))))
        .child(tile(nameOf(q), { kind: q.loose ? "agent" : "project", size: 16, radius: 4, glyph: q.loose ? "bot" : undefined }))
        .child(div().flex_1().min_w(0).truncate().text_size(T.text.sm).text_color(on ? t.foreground : t.muted).child(nameOf(q)))
        .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(q.loose ? "agent" : "project"));
    };
    rows.push(v_flex().child(this.label(t, "Shared with"))
      .child(projs.length
        ? v_flex().rounded(T.r.panel).border_1().border_color(t.border).overflow_hidden()
          .child(h_flex().flex_none().p(T.sp.sm).gap(T.sp.md).items_center().bg(t.raised)
            .child(h_flex().flex_1().h(T.h.btnSm).px(8).gap(6).items_center().rounded(T.r.ctrl).bg(t.background).border_1().border_color(qv ? t.accent : t.input)
              .child(iconEl("search", t.dim, 12)).child(Input.new(this.shareQ).flex_1().h(24).text_size(T.text.sm).text_color(t.foreground)))
            .child(div().flex_none().text_size(T.text.xs).text_color(t.dim).child(`${this.share.size} of ${projs.length}`)))
          .child(!shown.length ? h_flex().h(28).px(T.sp.md).items_center().text_size(T.text.sm).text_color(t.dim).child("No matches")
            : shown.length > 6 ? scrollY("mp-sw-sh-scroll", v_flex().max_h(28 * 6).children(shown.map(shareRow)), { grow: false })
            : v_flex().children(shown.map(shareRow)))
        : div().text_size(T.text.xs).text_color(t.dim).child("No projects yet")));
    return v_flex().children(rows);
  }

  render() {
    const t = theme();
    const edit = this.p.edit;
    const title = edit ? `Edit Secret · ${edit.name}` : this.step === 1 ? "New Secret" : this.step === 2 ? this.prov.name : "New Secret";
    const sub = edit ? null : this.step === 1 ? "Pick a service" : this.step === 2 ? "Pick the kind of credential" : null;
    const body = this.step === 1 ? this.providers(t) : this.step === 2 ? this.types(t) : this.fields(t);
    const canBack = !edit && this.step > 1;
    return v_flex().id("mp-form").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().px(24).pt(16).pb(4).gap(8).items_center()
        .child(this.step === 2 && !edit
          ? tile(this.prov.name, { size: 30, glyph: this.prov.glyph, color: this.prov.color, radius: 8 })
          : div())
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(T.text.lg).font_semibold().child(title))
          .when(Boolean(sub), (el) => el.child(div().text_size(T.text.xs).text_color(t.dim).child(sub))))
        .when(!edit, (el) => el.child(h_flex().gap(4).items_center().children([1, 2, 3].map((n) => div().w(n === this.step ? 16 : 6).h(6).rounded_full()
          .bg(n <= this.step ? t.accent : t.border))))))
      .child(scrollY("mp-sw-body", v_flex().px(24).max_h(600)
        .child(body)
        .when(Boolean(this.error), (el) => el.child(div().mt(12).p(8).rounded(T.r.ctrl).bg(t.hover).text_size(T.text.xs).text_color(t.blocked).whitespace_normal().child(this.error))), { grow: false }))
      // Footer like every other dialog: key hints left (Enter submits on the last step), buttons right.
      .child(h_flex().flex_none().px(24).pt(T.sp.xl).pb(T.sp.xl).gap(T.sp.md).items_center()
        .child(h_flex().flex_1().min_w(0).gap(T.sp.xs).items_center().text_size(T.text.xs).text_color(t.dim)
          .when(this.step === 3, (el) => el.child(kbd(t, "Enter")).child(div().pr(T.sp.md).child("submit")))
          .child(kbd(t, "Esc")).child(div().child("cancel")))
        .when(canBack, (el) => el.child(button(t, "mp-sw-back", "Back", (_e, cx) => this.back(cx), { iconName: "chevron-left", ghost: true })))
        .child(button(t, "mp-f-cancel", "Cancel", () => this.close()))
        .when(this.step === 3, (el) => el.child(button(t, "mp-f-ok", this.busy ? "Saving…" : "Save", (_e, cx) => this.submit(cx), { primary: true }))));
  }
}
