// Charts. Lines and areas are native GPUI paths (window.paint_path with percent coordinates, so they
// scale with their box): no files, no decoded images, nothing grows when the data changes every tick.
// Bars, axes, grids and heat cells are plain divs (hover tooltips per column). SVG files in .gen/ remain
// only for the fallback (no paint_path), the lineage graph (svgImage) and rings (a bounded set).
// Look: Grafana stat panels (big number + sparkline), Vercel/Linear insights (flat, quiet gridlines,
// 3 y ticks, sparse x labels), Datadog host map (one cell per host, colored by load).
import { image, div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { T } from "./tokens.js";
import { appHome } from "herdr";
import * as fs from "fs/promises";

const DIR_REL = "mods/hyper-view/.gen";
const dirAbs = () => `${String(appHome()).replace(/\\/g, "/")}/${DIR_REL}`;
const written = (globalThis.__hvGenWritten ??= new Set()); // every chart file in use by any part
const current = (globalThis.__hvGenCurrent ??= new Map()); // chart key -> file (global: survives a hot reload like `written`)
let made = false;

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

// Smooth line (Catmull-Rom -> Bezier) through the points.
function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function svgText(values, color, w, h, { fill = true, max, stroke = 1.6 } = {}) {
  const vals = values.length >= 2 ? values : values.length === 1 ? [values[0], values[0]] : [0, 0];
  const hi = max ?? Math.max(1, ...vals);
  const pad = stroke + 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, pad + (h - 2 * pad) * (1 - Math.min(1, Math.max(0, v / hi)))]);
  const line = smooth(pts);
  const area = `${line} L${w},${h} L0,${h} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">`
    + (fill ? `<path d="${area}" fill="${color}" fill-opacity="0.08"/>` : "")
    + `<path d="${line}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// ------------------------------------------------------------ native paths
const PAINT = () => (typeof globalThis.window?.paint_path === "function" && PathBuilder ? globalThis.window : null);
const pc = (v) => `${(Math.round(Math.max(-5, Math.min(105, v)) * 100) / 100)}%`;
const alpha = (c, a) => `${String(c).slice(0, 7)}${a}`;
// Points (x, y in 0..100 percent of the box) for the values: top inset 6%, bottom at 100%.
function pctPoints(values, hi, lo = 0, top = 6) {
  const vals = values.length >= 2 ? values : values.length === 1 ? [values[0], values[0]] : [0, 0];
  const span = Math.max(1e-9, hi - lo);
  return vals.map((v, i) => [(i / (vals.length - 1)) * 100, top + (100 - top) * (1 - Math.min(1, Math.max(0, ((Number.isFinite(v) ? v : 0) - lo) / span)))]);
}
function trace(b, pts, curved) {
  b = b.move_to(pc(pts[0][0]), pc(pts[0][1]));
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    if (!curved) { b = b.line_to(pc(p2[0]), pc(p2[1])); continue; }
    // Catmull-Rom -> Bezier, control y clamped to the segment so the curve never overshoots the box.
    const yl = Math.min(p1[1], p2[1]), yh = Math.max(p1[1], p2[1]);
    const c1y = Math.max(yl, Math.min(yh, p1[1] + (p2[1] - p0[1]) / 6)), c2y = Math.max(yl, Math.min(yh, p2[1] - (p3[1] - p1[1]) / 6));
    b = b.cubic_bezier_to(pc(p2[0]), pc(p2[1]), pc(p1[0] + (p2[0] - p0[0]) / 6), pc(c1y), pc(p2[0] - (p3[0] - p1[0]) / 6), pc(c2y));
  }
  return b;
}
// Layers (absolute, filling a relative parent) that draw a line, optionally over a faint flat area.
// Returns [] when the host has no paint_path (callers then fall back to an SVG file).
const MAX_PTS = 16;
export function pathLayers(values, color, { max, min = 0, fill = true, stroke = 1.5, curved = true, top = 6 } = {}) {
  const W = PAINT();
  if (!W) return [];
  // Every path coordinate is parsed by the host (a "12.5%" string each), and a curve takes 6 per point:
  // a dozen chart lines of 30-48 curved points per frame ran renders out of time ("interrupted" in
  // trace / pc / coordinate). At most 16 points (averaged buckets), curves only for short series.
  let vals = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (vals.length > MAX_PTS) {
    const out = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const a = Math.floor((i * vals.length) / MAX_PTS), b = Math.max(a + 1, Math.floor(((i + 1) * vals.length) / MAX_PTS));
      const part = vals.slice(a, b); out.push(part.reduce((s, x) => s + x, 0) / part.length);
    }
    vals = out;
  }
  curved = curved && vals.length <= 12;
  const hi = max ?? Math.max(1, ...vals);
  const pts = pctPoints(vals, hi, min, top);
  const out = [];
  if (fill) out.push(W.paint_path(trace(PathBuilder.fill(), pts, curved).line_to("100%", "100%").line_to("0%", "100%").close().build(), alpha(color, "1f")).absolute().top(0).left(0).size_full());
  out.push(W.paint_path(trace(PathBuilder.stroke(stroke), pts, curved).build(), color).absolute().top(0).left(0).size_full());
  return out;
}
// Sparkline box of w x h px (w may be "100%" style strings via opts.fluid): native path, file fallback.
export function sparkLine(id, values, color, w, h, opts = {}) {
  const layers = pathLayers(values, color, opts);
  if (!layers.length) return svgSpark(id, values, color, typeof w === "number" ? w : 200, h, opts);
  let el = div().id(id).relative().h(h).flex_none();
  el = typeof w === "number" ? el.w(w) : el.w_full();
  return el.children(layers);
}

// Nice upper bound for an axis (1, 2, 2.5, 5 x 10^k) and compact number labels.
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v)), f = v / e;
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9) ?? 10) * e;
}
export const fmtNum = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(Math.round(n * 10) / 10));

// Column chart with axes: 3 y ticks on quiet gridlines, sparse x labels, a hover tooltip per column.
// cols: [{ label, tip, segs: [[value, color], ...] }] (segments stack bottom-up). opts.line: { values, color }
// draws a native line over the bars (or alone when the segments are empty: a line chart with hover columns).
export function columnChart(t, id, cols, { h = 160, fmt = fmtNum, xEvery = 5, max, line, barW, today = true } = {}) {
  const totals = cols.map((c) => (c.segs ?? []).reduce((s, [v]) => s + (Number(v) || 0), 0));
  const hi = niceMax(max ?? Math.max(1, ...totals, ...(line?.values ?? [0])));
  const n = cols.length;
  const yAxis = v_flex().flex_none().w(36).h(h + 12).mt(-6).justify_between().items_end().pr(T.sp.md)
    .children([hi, hi / 2, 0].map((v, i) => div().h(12).text_size(T.text.micro).line_height("12px").text_color(t.dim).child(i === 2 ? "0" : fmt(v))));
  const grid = [0, 0.5, 1].map((f, i) => div().absolute().left(0).right(0).top(Math.round(h * f) - (i === 2 ? 1 : 0)).h(1).bg(i === 2 ? t.border : alpha(t.border, "99")));
  const bars = h_flex().absolute().top(0).left(0).size_full().items_end().gap(n > 40 ? 1 : 2)
    .children(cols.map((c, i) => {
      const segs = (c.segs ?? []).filter(([v]) => v > 0);
      let col = v_flex().id(`${id}-c${i}`).flex_1().min_w(0).h_full().justify_end().items_center().rounded_t(2).hover((s) => s.bg(t.hover)).tooltip(c.tip ?? `${c.label}: ${fmt(totals[i])}`);
      const inner = v_flex().w(barW ?? "72%").min_w(2).justify_end().children(segs.slice().reverse().map(([v, color], k) =>
        div().w_full().flex_none().h(Math.max(1, Math.round((h * v) / hi))).bg(color).when(k === 0, (e) => e.rounded_t(2))));
      return col.child(inner);
    }));
  const plot = div().id(`${id}-plot`).relative().flex_1().min_w(0).h(h).children(grid).child(bars)
    .when(Boolean(line), (e) => e.children(pathLayers(line.values, line.color, { max: hi, fill: line.fill ?? true, top: 0, stroke: line.stroke ?? 1.75, curved: line.curved ?? true })));
  // X labels: absolutely placed at their column's left edge (they may be wider than a column).
  const xs = div().relative().w_full().h(14).children(cols.map((c, i) => [c, i]).filter(([, i]) => (i % xEvery === 0 && n - 1 - i >= xEvery / 2) || i === n - 1).map(([c, i]) => {
    const last = i === n - 1;
    const el = div().absolute().top(0).whitespace_nowrap().text_size(T.text.micro).text_color(last ? t.muted : t.dim).child(last && today ? "today" : c.label);
    return last ? el.right(0) : el.left(`${((i / n) * 100).toFixed(2)}%`);
  }));
  return h_flex().id(id).w_full().items_start()
    .child(yAxis)
    .child(v_flex().flex_1().min_w(0).gap(4).child(plot).child(xs));
}

// Legend: colored squares + labels (+ optional values), one line, wrapping.
export function legend(t, items) {
  return h_flex().flex_wrap().gap(12).items_center()
    .children(items.map(([label, color, value]) => h_flex().gap(6).items_center()
      .child(div().flex_none().size(8).rounded(2).bg(color))
      .child(div().text_size(T.text.xs).text_color(t.muted).child(label))
      .when(value != null, (e) => e.child(div().text_size(T.text.xs).text_color(t.dim).child(String(value))))));
}

// Load colour for heat cells (0-100): flat steps, no gradient.
export function loadColor(v, t) {
  if (!Number.isFinite(v)) return t?.raised ?? "#333333";
  return v >= 85 ? "#d57c74" : v >= 70 ? "#d4a35a" : v >= 45 ? "#7fb08a" : v >= 20 ? "#7fb08aaa" : "#7fb08a66";
}
// Heat grid: one small square per item (Datadog host map). cells: [{ key, color, tip, onClick, outline }]
export function heatGrid(t, id, cells, { size = 12, gap = 3 } = {}) {
  return h_flex().id(id).w_full().flex_wrap().gap(gap)
    .children(cells.map((c, i) => div().id(`${id}-${i}`).flex_none().size(size).rounded(2).bg(c.color)
      .when(Boolean(c.outline), (e) => e.border_1().border_color(c.outline))
      .tooltip(c.tip ?? c.key).when(Boolean(c.onClick), (e) => e.cursor_pointer().hover((s) => s.opacity(0.75)).on_click((_e, cx) => { c.onClick(cx); cx.notify(); }))));
}

// Small sparkline (fixed px box). Native path when the host can paint paths; else an SVG file.
export function spark(key, values, color, w, h, opts = {}) {
  const layers = pathLayers(values, color, opts);
  if (layers.length) return div().relative().w(w).h(h).flex_none().children(layers);
  return svgSpark(key, values, color, w, h, opts);
}
// Fallback: the chart as an SVG file (one current file per key; the previous one is deleted).
function svgSpark(key, values, color, w, h, opts = {}) {
  const text = svgText(values.map((v) => (Number.isFinite(v) ? v : 0)), color, w, h, opts);
  const name = `${key.replace(/[^a-z0-9-]/gi, "_")}-${hash(text)}.svg`;
  const prev = current.get(key);
  if (prev !== name) {
    current.set(key, name);
    if (!written.has(name)) {
      written.add(name);
      (async () => {
        if (!made) { await fs.mkdir(dirAbs(), { recursive: true }).catch(() => {}); made = true; }
        await fs.writeFile(`${dirAbs()}/${name}`, text).catch(() => {});
        if (prev) { written.delete(prev); fs.unlink(`${dirAbs()}/${prev}`).catch(() => {}); }
      })();
    }
  }
  return image(`${DIR_REL}/${name}`).w(w).h(h).flex_none();
}

// Live mini chart drawn with divs (no file, no image): for values that change every few seconds
// (status bar, machine rows). A new SVG per sample meant a new image file and a new decoded image
// in the app's image cache every 5 s, for ever.
export function liveBars(id, values, color, w, h, { max } = {}) {
  const bw = 2, n = Math.max(1, Math.floor((w + 1) / (bw + 1))); // 2 px bars, 1 px apart, newest on the right
  const vals = values.slice(-n).map((v) => (Number.isFinite(v) ? v : 0));
  const hi = max ?? Math.max(1, ...vals);
  return h_flex().id(id).w(w).h(h).flex_none().items_end().justify_end().gap(1)
    .children(vals.map((v, i) => div().flex_none().w(bw).h(Math.max(1, Math.round((h * Math.min(1, v / hi))))).rounded(1)
      .bg(i === vals.length - 1 ? color : `${String(color).slice(0, 7)}80`)));
}

// Any generated SVG (e.g. the lines of the lineage graph in sources.js), shown as a w x h image.
export function svgImage(key, text, w, h) {
  const name = `${key.replace(/[^a-z0-9-]/gi, "_")}-${hash(text)}.svg`;
  const prev = current.get(key);
  if (prev !== name) {
    current.set(key, name);
    if (!written.has(name)) {
      written.add(name);
      (async () => {
        if (!made) { await fs.mkdir(dirAbs(), { recursive: true }).catch(() => {}); made = true; }
        await fs.writeFile(`${dirAbs()}/${name}`, text).catch(() => {});
        if (prev) { written.delete(prev); fs.unlink(`${dirAbs()}/${prev}`).catch(() => {}); }
      })();
    }
  }
  return image(`${DIR_REL}/${name}`).w(w).h(h).flex_none();
}

// Circular progress ring as SVG.
export function ring(key, pct, color, track, size = 28, width = 4) {
  const r = (size - width) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct || 0));
  const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
    + `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${width}"/>`
    + `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  const name = `ring-${hash(text)}.svg`;
  if (!written.has(name)) {
    written.add(name);
    (async () => {
      if (!made) { await fs.mkdir(dirAbs(), { recursive: true }).catch(() => {}); made = true; }
      await fs.writeFile(`${dirAbs()}/${name}`, text).catch(() => {});
    })();
  }
  return image(`${DIR_REL}/${name}`).size(size).flex_none();
}

// Removes chart files this app run does not use (left over from earlier runs). All parts of the mod
// share this module, so `written` is every file in use. Called by maintenance.js.
export async function sweepGen() {
  let names = [];
  try { names = await fs.readdir(dirAbs()); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith(".svg") || written.has(f)) continue;
    await fs.unlink(`${dirAbs()}/${f}`).then(() => n++).catch(() => {});
  }
  return n;
}

// Buckets: how many events fall in each of N slots over the last `span` ms.
export function buckets(times, n = 24, span = 60 * 60 * 1000) {
  const now = Date.now(), out = new Array(n).fill(0);
  for (const t of times) {
    const age = now - new Date(t).getTime();
    if (age < 0 || age >= span) continue;
    out[n - 1 - Math.floor((age / span) * n)]++;
  }
  return out;
}
