// The page skeleton's half of "Pewter Curio": the wood, and which theme the
// wood is stained.
//
// `tokens.ts` covers shadow roots, which is almost everything — but the two
// index.html files are light DOM, and light DOM gets none of it. Rather than
// have each page hand-copy a palette into an inline `<style>` (which is how
// the two pages' colours drifted apart the first time), the page adopts this
// sheet and keeps its own inline style for layout only.
//
// **The two text faces are the demo's import, not this file's.** `@font-face`
// has to be processed by a bundler that can rewrite the `url()`s at its own
// woff2 files, and this package builds with plain `tsc`. Each demo's
// `main.ts` does:
//
//     import "@fontsource/instrument-serif";
//     import "@fontsource/jetbrains-mono";
//
// Icons are the exception, and they come from here — see `ICON_NAMES`. A
// document-scoped `@font-face` reaches into every shadow root on its own, so
// those imports serve the whole page. The rule sets that USE them do not
// cross that boundary — see `icons` in tokens.ts.
import { rootVars } from "./tokens.js";

/** What the human picked. `system` follows the OS; the other two override it.
 *  Light is the default — this theme is a light-wood cabinet first, and the
 *  dark one is its inversion. */
export type ThemePref = "light" | "dark" | "system";

const KEY = "fsio-theme";

/** Ash grain, drawn rather than shipped: an image asset would be one more
 *  thing for the bundler to place and one more file to look at, and this is
 *  three lines of turbulence.
 *
 *  `baseFrequency` is deliberately lopsided — 0.006 across, 0.62 down — which
 *  makes the noise vary slowly along x and fast along y, i.e. long horizontal
 *  streaks. That is what grain is. `stitchTiles` keeps the seams invisible
 *  when it tiles. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E" +
  "%3Cfilter id='g' x='0' y='0' width='100%25' height='100%25'%3E" +
  "%3CfeTurbulence type='fractalNoise' baseFrequency='0.006 0.62' numOctaves='5' seed='11' stitchTiles='stitch'/%3E" +
  "%3CfeColorMatrix type='saturate' values='0'/%3E" +
  "%3C/filter%3E%3Crect width='1200' height='800' filter='url(%23g)'/%3E%3C/svg%3E\")";

/** The wood, the reset, and the vocabulary at `:root`.
 *
 *  Two layers make the board, and they are deliberately NOT in the same one.
 *  The figure — the slow light banding across a sawn board — is painted flat
 *  on `body`, in wood tones, with soft stops. The grain is turbulence on a
 *  `::before` that blends into it.
 *
 *  They were one layer first, and that was wrong twice over: multiplying a
 *  near-wood colour over wood squares the tone, so a band set a hair away
 *  from the base landed several shades away, and hard gradient stops that
 *  would have been invisible flat came out as stripes. Blend the noise, paint
 *  the figure — then the sheen token means the distance it says.
 *
 *  Both are fixed rather than scrolling: one composited layer, no repaint on
 *  scroll, and the board does not slide out from under a long conversation. */
const SHEET = `
  :root {
    ${rootVars}
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--fsio-sans);
    background-color: var(--fsio-wood);
    /* Every stop is a colour transition, never a hard edge, and the period is
       wider than the viewport is tall — a board's figure is something you
       notice second, after the grain. */
    background-image: repeating-linear-gradient(
      95deg,
      var(--fsio-wood) 0,
      var(--fsio-wood-sheen) 210px,
      var(--fsio-wood) 430px,
      var(--fsio-wood) 520px,
      var(--fsio-wood-sheen) 760px,
      var(--fsio-wood) 1020px
    );
    background-attachment: fixed;
    color: var(--fsio-fg);
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: "";
    position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background-image: ${GRAIN};
    background-size: 620px 420px;
  }
  /* Multiply darkens the ash where the grain is dark, which is what grain
     does to wood. On a dark stain there is nothing left to darken, so the
     same noise goes to soft-light and lifts the sheen instead — the board is
     the same board, catching light rather than absorbing it. Not a
     light-dark() pair because light-dark() takes colours only. */
  :root[data-theme="light"] body::before { mix-blend-mode: multiply; opacity: 0.4; }
  :root[data-theme="dark"] body::before { mix-blend-mode: soft-light; opacity: 0.52; }

  [hidden] { display: none !important; }

  /* Scrollbars, so a pale page does not get a dark UA scrollbar bolted to its
     edge. */
  * { scrollbar-width: thin; scrollbar-color: var(--fsio-line-strong) transparent; }
`;

/** Every Material Symbol either page draws, and the only list of them.
 *
 *  This is not documentation — it is the request. Google Fonts subsets the
 *  font to exactly the names asked for via `icon_names`, so the list below IS
 *  the payload: adding a glyph means adding a line here, and drawing one that
 *  is not here renders its own name as text.
 *
 *  Why this and not the `material-symbols` npm package: that package ships
 *  the whole variable font, measured at 3.96 MB, for the twenty-one glyphs
 *  below. The subset is a rounding error against that. The cost is a network
 *  dependency — offline, the icons fall back to their names in words while
 *  the rest of the page (both text faces are self-hosted) is unaffected.
 *
 *  Sorted, because the URL is a cache key and an unsorted list churns it. */
export const ICON_NAMES = [
  "add",
  "check_circle",
  "chevron_right",
  "close",
  "contrast",
  "content_copy",
  "dark_mode",
  "draft",
  "edit_document",
  "error",
  "folder_open",
  "forum",
  "hourglass_top",
  "info",
  "light_mode",
  "link_off",
  "lock",
  "more_horiz",
  "refresh",
  "send",
  "terminal",
  "visibility",
  "warning",
].sort();

/** The axis ranges have to cover every `font-variation-settings` the `icons`
 *  rule set asks for — a subset served without an axis silently ignores it,
 *  which shows up as icons at the wrong weight rather than as an error.
 *
 *  `display=block` because the fallback for a ligature font is the ligature's
 *  own name: better a beat of nothing than a flash of the word "close". */
const ICON_HREF =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" +
  ":opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" +
  `&icon_names=${ICON_NAMES.join(",")}&display=block`;

function installIconFont(): void {
  for (const [href, cross] of [
    ["https://fonts.googleapis.com", false],
    ["https://fonts.gstatic.com", true],
  ] as const) {
    const pre = document.createElement("link");
    pre.rel = "preconnect";
    pre.href = href;
    if (cross) pre.crossOrigin = "";
    document.head.append(pre);
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = ICON_HREF;
  document.head.append(link);
}

let sheet: CSSStyleSheet | null = null;

/** Resolve `system` against the OS. Called on every apply, and again whenever
 *  the OS flips while the pref is `system`. */
function resolve(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(pref: ThemePref): void {
  document.documentElement.dataset["theme"] = resolve(pref);
}

/** Adopt the page theme and settle on a stain. Call once, first thing in a
 *  demo's `main.ts` — before the components import, so the first paint is
 *  already the right colour.
 *
 *  Adopted rather than injected as a `<style>`: `adoptedStyleSheets` is one
 *  parsed sheet the page cannot accidentally out-specify, and it lands before
 *  the first component upgrade. */
export function installPageTheme(): void {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(SHEET);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  installIconFont();
  apply(getTheme());
  // Only meaningful while the pref is `system`, but harmless otherwise, and
  // registering once here beats every page remembering to.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") apply("system");
  });
}

/** What the human picked, defaulting to light. Storage can throw (a page in a
 *  partitioned or blocked-storage context still has to render), and a theme
 *  is not worth a broken page. */
export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "light";
}

/** Pick a stain, and remember it. */
export function setTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  apply(pref);
}

/** Which stain is actually on the page right now — `system` resolved. */
export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}
