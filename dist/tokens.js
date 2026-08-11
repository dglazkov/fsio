// "Pewter Curio", as a pewter's screens see it.
//
// The theme is a pale ash cabinet: light wood with the grain still in it,
// glass panels resting a millimetre off that wood, and everything drawn in
// pewter. Light is the default; dark is the same cabinet under a darker
// stain, where the pewter stops absorbing light and starts catching it.
//
// **Copied from `@fsio/ui`, not shared with it** (#164: Pewter copies from
// the demos and the duplication is accepted). It has to be a copy: this
// package ships to a stranger's pewter through an artifact branch and is
// bundled into a sandboxed frame, and dragging the demos' shared chrome in
// behind it would ship three pages nobody asked for. What is here is the
// vocabulary an extension can use, and none of the components.
//
// **Every value is a `light-dark()` pair**, so the two themes are one table
// and cannot drift. Which half applies is decided by `color-scheme`, which
// the page sets once — nothing here reads a media query and no element knows
// which theme it is in.
//
// **Named for the job, never for the colour.** `--pewter-bad` can stop being
// red; `--pewter-red` cannot stop being red. That rule is what lets the whole
// theme change without an element changing at all.
//
// **The faces are stacks, not files.** Curio's own are JetBrains Mono and
// Instrument Serif, which the demos and the shell load as `@fontsource`
// packages. An extension cannot: its frame is a separate document with an
// opaque origin, so a `@font-face` the shell installed does not reach it, and
// its bundle must be one self-contained file with no network. Inlining the
// three faces measures ~96 KB of base64 in *every* extension bundle, against
// a repos screen that is 73 KB today — which lands on the strain #164 already
// names. So the stacks name the faces and fall back, and an extension that
// wants them can inline them itself.
import { css, unsafeCSS } from "lit";
/** The vocabulary, as one block, reused at `:host` for elements and at
 *  `:root` by the stylesheet for the page around them. */
const PUBLIC = `
  /* The surface an extension paints. A screen fills its frame, so this is
     the wood rather than a panel floating on it — the shell gives the frame
     the same colour underneath, so a screen that paints nothing still lands
     on the cabinet rather than on white. */
  --pewter-bg: light-dark(#efe9dc, #191614);

  /* Surfaces, most recessed first. Everything from --pewter-raised up is
     translucent: these are panes of glass, and what shows through them is
     the background. Compositing them over an opaque colour is what makes
     glass read as grey plastic. */
  --pewter-raised: light-dark(#fffdf9a6, #ffffff0f);
  --pewter-panel: light-dark(#fbf9f5b8, #2a2622b8);
  /* What floats over arbitrary content rather than over the background: a
     menu, a card over a terminal. Same family, nearly opaque — still glass
     at the edges, but it owns its own contrast. */
  --pewter-float: light-dark(#fcfaf7f5, #2b2723f7);
  --pewter-control: light-dark(#fffdfa99, #ffffff12);
  --pewter-control-hover: light-dark(#ffffffdb, #ffffff21);
  /* The faintest a surface gets: the tint behind a code span, the row a
     pointer is over. */
  --pewter-wash: light-dark(#5d52420f, #ffffff0d);

  /* Lines. Alpha rather than a mixed colour, so a hairline over glass picks
     up whatever is behind it instead of banding against it. */
  --pewter-hairline: light-dark(#5d524218, #ffffff0d);
  --pewter-line: light-dark(#5d52422b, #ffffff14);
  --pewter-line-strong: light-dark(#5d524245, #ffffff26);
  --pewter-line-control: light-dark(#5d524257, #ffffff36);

  /* Text, most emphatic first. Pewter: grey with a cold cast and a little
     blue left in it, never neutral. */
  --pewter-fg-bright: light-dark(#2b3035, #eceff1);
  --pewter-ink: light-dark(#3e4650, #cfd5da);
  --pewter-dim: light-dark(#616b75, #9aa3ab);
  --pewter-dimmer: light-dark(#7b858f, #7e878f);
  --pewter-dimmest: light-dark(#98a1aa, #646d75);

  /* Meaning. Antique rather than saturated — patina, ochre and oxblood, the
     colours a curio cabinet already has. "bright" means MORE emphatic, which
     on light wood means darker. */
  --pewter-accent: light-dark(#546a78, #5d7284);
  --pewter-accent-hover: light-dark(#455966, #6d8496);
  --pewter-on-accent: light-dark(#f7f9fa, #f2f6f8);
  --pewter-cyan: light-dark(#3f6f78, #8fbfc7);
  --pewter-good: light-dark(#4f7a55, #93b899);
  --pewter-warn: light-dark(#8a6a22, #dcba76);
  --pewter-bad: light-dark(#9b4a46, #c97d79);
  --pewter-bad-bright: light-dark(#8e3f3b, #e79a96);
  --pewter-error: light-dark(#8e3f3b, #e79a96);
  --pewter-accent-wash: light-dark(#546a781f, #63798a2b);
  --pewter-bad-wash: light-dark(#9b4a461a, #3a2523);

  /* The one thing that does NOT invert: a terminal is a dark slab in both
     themes, an object sitting in the cabinet rather than a region of the
     page. Keeping it fixed also keeps a terminal emulator's sixteen ANSI
     colours legible without remapping them per theme. */
  --pewter-slab: #17191c;
  --pewter-slab-fg: #d6dbdf;

  /* Glass. "Floating very close to the wood" is the whole brief: a tight
     contact shadow and a short throw, never a drop shadow. */
  --pewter-glass-edge: light-dark(#ffffffbf, #ffffff17);
  --pewter-lift: light-dark(
    0 1px 1px #3a30220f, 0 6px 16px -10px #3a302247,
    0 1px 1px #00000059, 0 6px 16px -10px #0000008c
  );

  /* Type. The mono is the workhorse — a pewter is a place for reading code.
     The serif is a single-weight display face: titles and wordmarks only,
     never a paragraph. Both name the Curio faces first and fall back, for
     the reason in this file's header. */
  --pewter-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --pewter-title: "Instrument Serif", Georgia, "Times New Roman", serif;
  --pewter-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
`;
/** The same table, but every default reachable from outside.
 *
 *  This indirection is the restyling rail and it is not decoration: a bare
 *  `--pewter-line: <default>` declared on `:host` would win against an
 *  extension setting `--pewter-line` on an ancestor, because a `:host`
 *  declaration applies to the element's own subtree. Computing a private
 *  `--_line` from the public name lets an outside value through and keeps a
 *  default when there is none. */
const PRIVATE = `
  /* The surface an extension paints. A screen fills its frame, so this is
     the wood rather than a panel floating on it — the shell gives the frame
     the same colour underneath, so a screen that paints nothing still lands
     on the cabinet rather than on white. */
  --_bg: var(--pewter-bg, light-dark(#efe9dc, #191614));

  /* Surfaces, most recessed first. Everything from --pewter-raised up is
     translucent: these are panes of glass, and what shows through them is
     the background. Compositing them over an opaque colour is what makes
     glass read as grey plastic. */
  --_raised: var(--pewter-raised, light-dark(#fffdf9a6, #ffffff0f));
  --_panel: var(--pewter-panel, light-dark(#fbf9f5b8, #2a2622b8));
  /* What floats over arbitrary content rather than over the background: a
     menu, a card over a terminal. Same family, nearly opaque — still glass
     at the edges, but it owns its own contrast. */
  --_float: var(--pewter-float, light-dark(#fcfaf7f5, #2b2723f7));
  --_control: var(--pewter-control, light-dark(#fffdfa99, #ffffff12));
  --_control-hover: var(--pewter-control-hover, light-dark(#ffffffdb, #ffffff21));
  /* The faintest a surface gets: the tint behind a code span, the row a
     pointer is over. */
  --_wash: var(--pewter-wash, light-dark(#5d52420f, #ffffff0d));

  /* Lines. Alpha rather than a mixed colour, so a hairline over glass picks
     up whatever is behind it instead of banding against it. */
  --_hairline: var(--pewter-hairline, light-dark(#5d524218, #ffffff0d));
  --_line: var(--pewter-line, light-dark(#5d52422b, #ffffff14));
  --_line-strong: var(--pewter-line-strong, light-dark(#5d524245, #ffffff26));
  --_line-control: var(--pewter-line-control, light-dark(#5d524257, #ffffff36));

  /* Text, most emphatic first. Pewter: grey with a cold cast and a little
     blue left in it, never neutral. */
  --_fg-bright: var(--pewter-fg-bright, light-dark(#2b3035, #eceff1));
  --_ink: var(--pewter-ink, light-dark(#3e4650, #cfd5da));
  --_dim: var(--pewter-dim, light-dark(#616b75, #9aa3ab));
  --_dimmer: var(--pewter-dimmer, light-dark(#7b858f, #7e878f));
  --_dimmest: var(--pewter-dimmest, light-dark(#98a1aa, #646d75));

  /* Meaning. Antique rather than saturated — patina, ochre and oxblood, the
     colours a curio cabinet already has. "bright" means MORE emphatic, which
     on light wood means darker. */
  --_accent: var(--pewter-accent, light-dark(#546a78, #5d7284));
  --_accent-hover: var(--pewter-accent-hover, light-dark(#455966, #6d8496));
  --_on-accent: var(--pewter-on-accent, light-dark(#f7f9fa, #f2f6f8));
  --_cyan: var(--pewter-cyan, light-dark(#3f6f78, #8fbfc7));
  --_good: var(--pewter-good, light-dark(#4f7a55, #93b899));
  --_warn: var(--pewter-warn, light-dark(#8a6a22, #dcba76));
  --_bad: var(--pewter-bad, light-dark(#9b4a46, #c97d79));
  --_bad-bright: var(--pewter-bad-bright, light-dark(#8e3f3b, #e79a96));
  --_error: var(--pewter-error, light-dark(#8e3f3b, #e79a96));
  --_accent-wash: var(--pewter-accent-wash, light-dark(#546a781f, #63798a2b));
  --_bad-wash: var(--pewter-bad-wash, light-dark(#9b4a461a, #3a2523));

  /* The one thing that does NOT invert: a terminal is a dark slab in both
     themes, an object sitting in the cabinet rather than a region of the
     page. Keeping it fixed also keeps a terminal emulator's sixteen ANSI
     colours legible without remapping them per theme. */
  --pewter-slab: #17191c;
  --pewter-slab-fg: #d6dbdf;

  /* Glass. "Floating very close to the wood" is the whole brief: a tight
     contact shadow and a short throw, never a drop shadow. */
  --_glass-edge: var(--pewter-glass-edge, light-dark(#ffffffbf, #ffffff17));
  --pewter-lift: light-dark(
    0 1px 1px #3a30220f, 0 6px 16px -10px #3a302247,
    0 1px 1px #00000059, 0 6px 16px -10px #0000008c
  );

  /* Type. The mono is the workhorse — a pewter is a place for reading code.
     The serif is a single-weight display face: titles and wordmarks only,
     never a paragraph. Both name the Curio faces first and fall back, for
     the reason in this file's header. */
  --_mono: var(--pewter-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace);
  --_title: var(--pewter-title, "Instrument Serif", Georgia, "Times New Roman", serif);
  --_sans: var(--pewter-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
`;
/** The vocabulary for a shadow root. Put it first in any `static styles` that
 *  reads a `--pewter-*` name.
 *
 *  No `color-scheme` here, and that is load-bearing: declaring it on a
 *  `:host` re-opens the light/dark question for that subtree, so every
 *  element would answer it from the OS preference instead of from whatever
 *  the page settled on. `color-scheme` inherits, so leaving it alone is what
 *  makes elements follow the page. */
export const tokens = css `
  :host {
    ${unsafeCSS(PRIVATE)}
  }
`;
/** The same vocabulary at `:root`, for the stylesheet. Exported so a screen
 *  that drops `pewter-ui/style.css` and writes its own can still start from
 *  the palette. */
export const rootVars = PUBLIC;
/** What every button in here starts from.
 *
 *  The three declarations are not taste, they are the shadow boundary: a
 *  `<button>` gets its font and its colour from the UA stylesheet rather
 *  than by inheritance, so one inside a shadow root ignores the page's font
 *  entirely unless it is told not to. Outside, `pewter-ui/style.css` says
 *  the same thing once for the whole document; in here each element has to
 *  say it for itself. */
export const control = css `
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
//# sourceMappingURL=tokens.js.map