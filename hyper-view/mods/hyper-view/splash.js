// Start-up splash. The ghost pops in with a soft spring, smiles, waves and floats while
// "Hi, <user>" rises in; then everything dissolves into the app.
// All motion is native GPUI (spring / transition / loop on size, position and opacity), so it is
// smooth at any frame rate: this code only switches phases, the engine animates between them.
import { T } from "./tokens.js";
import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, home } from "herdr";
import { MOD } from "./lib.js";

const img = (name) => `mods/${MOD}/icons/splash/${name}.svg`;
const SIZE = 280, BOX = 380;
// 0 hidden · 1 pop in · 2 smile + wave · 3 greeting · 4 subtitle · 5 wave ends · 6 dissolve
const TIMELINE = [[80, 1], [950, 2], [1250, 3], [1650, 4], [3500, 5], [3900, 6]];
const CLOSE_AT = 4750;

function userName() {
  const base = String(home() ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "there";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function showSplash() {
  if (globalThis.__hvSplashShown) return;
  globalThis.__hvSplashShown = true;
  globalThis.__hvSplashId = openOverlay({ mod: MOD, props: { role: "splash" }, kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 } });
}

export class Splash {
  init(cx) {
    this.phase = 0;
    this.name = userName();
    this.overlay = (props() ?? {}).overlay;
    for (const [ms, ph] of TIMELINE) cx.timer.after(ms, (cx) => { this.phase = Math.max(this.phase, ph); cx.notify(); });
    cx.timer.after(CLOSE_AT, () => this.close());
  }
  // Close by every id we know: an overlay left open (even invisible) would swallow all clicks.
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of new Set([this.overlay, (props() ?? {}).overlay, globalThis.__hvSplashId].filter(Boolean))) { try { closeOverlay(id); } catch {} }
  }

  render() {
    const t = theme();
    const ph = this.phase;
    const accent = String(t.accent).slice(0, 7);
    const fade = (on, ms = 300, easing = "ease-in-out") => (el) => el.opacity(on ? 1 : 0).transition("opacity", { duration: ms, easing });
    const layer = (name) => image(img(name)).absolute().top(0).left(0).w_full().h_full();
    const waving = ph >= 2 && ph < 5;

    // Ghost: its size springs from small to full (a soft pop) and grows a little as it dissolves.
    const size = ph === 0 ? 80 : ph >= 6 ? 340 : SIZE;
    const ghost = div().relative().w(size).h(size)
      .spring("width", { response: 620, damping: 0.58 }).spring("height", { response: 620, damping: 0.58 })
      .map(fade(ph >= 1 && ph < 6, ph >= 6 ? 650 : 380))
      // waving arm: two poses cross-fading back and forth (ease-in-out, so it lingers at each end)
      .child(div().absolute().top(0).left(0).w_full().h_full()
        .when(waving, (el) => el.loop("opacity", { from: 1, to: 0, period: 720 }))
        .when(!waving, (el) => el.opacity(1))
        .child(layer("arm-a")))
      .child(div().absolute().top(0).left(0).w_full().h_full()
        .when(waving, (el) => el.loop("opacity", { from: 0, to: 1, period: 720 }))
        .when(!waving, (el) => el.opacity(0))
        .child(layer("arm-b")))
      .child(layer("body"))
      .child(div().absolute().top(0).left(0).w_full().h_full().map(fade(ph < 2, 260)).child(layer("eyes")))
      .child(div().absolute().top(0).left(0).w_full().h_full().map(fade(ph >= 2, 260)).child(layer("eyes-happy")))
      .child(div().absolute().top(0).left(0).w_full().h_full().map(fade(ph < 2, 260)).child(layer("mouth")))
      .child(div().absolute().top(0).left(0).w_full().h_full().map(fade(ph >= 2, 260)).child(layer("mouth-smile")));

    // Fixed box so the springing ghost stays centred; it floats gently once it has appeared.
    const stage = h_flex().relative().w(BOX).h(BOX).items_center().justify_center()
      .when(ph >= 2, (el) => el.loop("top", { from: 0, to: -9, period: 2200 }))
      // soft glow: three faint rings, breathing slightly out of step
      .children([[150, "03"], [126, "03"], [104, "04"], [84, "04"], [66, "05"], [50, "05"]].map(([r, a], i) => div().absolute()
        .top(BOX / 2 - SIZE / 2 - r).left(BOX / 2 - SIZE / 2 - r).size(SIZE + 2 * r).rounded_full().bg(`${accent}${a}`)
        .map(fade(ph >= 1 && ph < 6, 900))
        .when(ph >= 1 && ph < 6, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 2600 + i * 250 }))))
      .child(ghost);

    const greet = v_flex().items_center().gap(8).relative()
      .child(div().relative().top(ph >= 3 ? 0 : 18).transition("top", { duration: 700, easing: "ease-out" })
        .map(fade(ph >= 3 && ph < 6, ph >= 6 ? 400 : 650, "ease-out"))
        .text_size(T.text.display).font_semibold().text_color(t.foreground).child(`Hi ${this.name}, I'm Codie`))
      .child(div().relative().top(ph >= 4 ? 0 : 12).transition("top", { duration: 700, easing: "ease-out" })
        .map(fade(ph >= 4 && ph < 6, ph >= 6 ? 400 : 650, "ease-out"))
        .text_size(T.text.base).text_color(t.muted).child("Welcome to Hyper-view Herdr by Marcel S"));

    return v_flex().id("mp-splash").size_full().items_center().justify_center().gap(6).bg(t.background)
      .map(fade(ph < 6, 750, "ease-in"))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.close(); })
      .child(stage)
      .child(greet);
  }
}
