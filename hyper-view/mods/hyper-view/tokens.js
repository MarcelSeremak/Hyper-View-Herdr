// hyper-view design tokens: the single source of truth for type, spacing, sizes, radii and motion.
// Desktop-dense scale (13px base), in line with Linear (13px UI text), Vercel Geist (label/copy 12-14,
// heading 20), GitHub Primer (body 12/14, controls 28/32) and Raycast/Zed (dense 28-32px rows).
//
// Rules (keep the UI precise and quiet):
// - Text: only the five steps below. Body = base 13, secondary/meta = sm 12, captions/counts = xs 11,
//   section/dialog titles = lg 15, page title / big numbers = xl 20. `micro` (10) is ONLY for numeric
//   badges inside a <= 16px circle and tiny chart axis labels.
// - Weights: regular for text, medium for labels/buttons, semibold for titles. No bold.
// - Spacing: 2 4 6 8 12 16 24 only. Cards pad 12 (dense) or 16 (roomy); page gutter 24.
// - Radius: 4 chip/badge, 6 control (button, input, row), 8 panel/card/popover, 10 dialog. Dots: full.
// - Colour: flat fills only (no gradients), shadows only on floating layers (popover, dialog, toast).
// - Status = dot + text. Counts = dim tabular numbers. Metadata = text joined with " · ".
// - Pulse only for live states ("working", "waiting"), never decoration.
//
// Lint: `grep -n "text_size([0-9]" *.js` must only match this file.
//   (Off-scale spacing check: grep -nE "\.(gap|px|py|p|pt|pb|pl|pr|m[xytblr]?)\((5|7|9|10|11|14|18|20)\)" *.js)
const TEXT = { micro: 10, xs: 11, sm: 12, base: 13, lg: 15, xl: 20, display: 36 };
const LINE = { micro: 12, xs: 16, sm: 18, base: 20, lg: 22, xl: 28, display: 40 };
// NOTE: gpui-kit's line_height(number) is a multiplier; pass line heights as `${T.lh.sm}px`.
const SPACE = [0, 2, 4, 6, 8, 12, 16, 24]; // T.space(1) = 2 ... T.space(7) = 24

export const T = {
  text: TEXT,
  lh: LINE,
  weight: { regular: 400, medium: 500, semibold: 600 },
  // Spacing by step index (0-7): 0 2 4 6 8 12 16 24. Named aliases for readability.
  space: (i) => SPACE[Math.max(0, Math.min(SPACE.length - 1, i | 0))],
  sp: { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 },
  pad: { card: 12, cardRoomy: 16, page: 24, row: 12 },
  // Control heights.
  h: {
    rowDense: 28, row: 32, rowTall: 40, // list rows: dense / default / with two lines of text
    btnSm: 26, btn: 28, icon: 24, input: 28, inputLg: 30,
    tab: 32, header: 40, tabbar: 36, chip: 18,
  },
  r: { chip: 4, ctrl: 6, panel: 8, dialog: 10 },
  icon: { row: 14, toolbar: 16, sm: 12 },
  dot: 6,
  // Motion (ms): hover/state changes, panels/drawers.
  motion: { fast: 120, state: 150, panel: 200 },
};

// Snap any px value to the nearest spacing step (for computed spacing).
export const snapSpace = (px) => SPACE.reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a), 0);
// Nearest type step for a raw px value (used by the refactor; prefer the named steps).
export const snapText = (px) => (px >= 17 ? TEXT.xl : px >= 14 ? TEXT.lg : px >= 12.5 ? TEXT.base : px >= 11.5 ? TEXT.sm : TEXT.xs);
