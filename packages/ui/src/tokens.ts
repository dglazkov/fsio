// "Pewter Curio" — the palette and the handful of rules that were written out
// longhand in every component of both pages.
//
// These are `css` fragments rather than a global stylesheet because every
// component here and in the demos renders into a shadow root, and a shadow
// root sees no page CSS. Custom properties DO cross that boundary, so
// `tokens` only has to be in scope somewhere above a rule that reads one —
// but putting it first in each component's `static styles` is one line and
// removes the question.
//
// The theme is a pale ash cabinet: light wood with the grain still in it,
// glass panels resting a millimetre off that wood, and everything drawn in
// pewter. Light is the default; dark is the same cabinet under a darker
// stain, where the pewter stops absorbing light and starts catching it.
//
// **Every value is a `light-dark()` pair**, so the two themes are one table
// and cannot drift apart the way the two pages' palettes did. Which half
// applies is decided by `color-scheme`, set once on `:root` by `theme.ts` —
// nothing here reads a media query, and no component knows which theme it is
// in. `light-dark()` needs Chrome 123+; these pages need File System Access,
// so that floor was already the floor.
import { css, unsafeCSS } from "lit";

/** The vocabulary, as one block of declarations reused at `:host` (for shadow
 *  roots, below) and at `:root` (for the page skeleton, by `theme.ts`).
 *
 *  Named for the job, never for the colour: `--fsio-bad` can stop being red,
 *  `--fsio-red` cannot stop being red. That rule is what let the whole theme
 *  change here without a component changing at all. */
const VARS = `
  /* No \`color-scheme\` here, and that is load-bearing. Declaring it on a
     :host re-opens the light/dark question for that subtree, so every
     component would answer it from the OS preference instead of from the
     stain the page settled on — shadow roots rendering light values on a
     dark page (measured: the whole component layer inverted, while
     document-scope content stayed correct). \`color-scheme\` inherits, so
     leaving it alone is what makes components follow :root. It is set in
     exactly one place: the \`[data-theme]\` rules in theme.ts. */

  /* The wood. Ash in the light; the same board darkly stained in the dark.
     Only the page skeleton paints these — a panel floats ON the wood, so a
     panel never uses them. */
  --fsio-wood: light-dark(#e7dfd0, #211d19);
  /* The figure — the slow light banding across a sawn board. Kept within a
     hair of --fsio-wood on purpose: it is painted normally (not multiplied),
     so whatever distance is set here is exactly the distance you see. */
  --fsio-wood-sheen: light-dark(#ece5d9, #262119);

  /* Surfaces, most recessed first. Everything from --fsio-raised up is
     translucent: these are panes of glass, and what shows through them is the
     wood. Compositing them over an opaque colour is what makes glass read as
     grey plastic. */
  --fsio-bg: light-dark(#efe9dc, #191614);
  --fsio-raised: light-dark(#fffdf9a6, #ffffff0f);
  --fsio-aside: light-dark(#faf7f199, #ffffff08);
  --fsio-panel: light-dark(#fbf9f5b8, #2a2622b8);
  /* What floats over ARBITRARY content, rather than over the wood: a
     popover, a dialog, a card on the terminal. --fsio-panel is tuned for
     glass on a board, and at that alpha a menu opened over the dark slab
     pulls the slab through and stops being readable. Same family, nearly
     opaque — still glass at the edges, but it owns its own contrast. */
  --fsio-float: light-dark(#fcfaf7f5, #2b2723f7);
  --fsio-control: light-dark(#fffdfa99, #ffffff12);
  --fsio-control-hover: light-dark(#ffffffdb, #ffffff21);

  /* Lines. Alpha rather than a mixed colour, so a hairline over glass picks
     up whatever is behind it instead of banding against it. */
  --fsio-line: light-dark(#5d52422b, #ffffff14);
  --fsio-line-strong: light-dark(#5d524245, #ffffff26);
  --fsio-line-control: light-dark(#5d524257, #ffffff36);

  /* Text, most emphatic first. Pewter: grey with a cold cast and a little
     blue left in it, never neutral. */
  --fsio-fg-bright: light-dark(#2b3035, #eceff1);
  --fsio-fg: light-dark(#3e4650, #cfd5da);
  --fsio-dim: light-dark(#616b75, #9aa3ab);
  --fsio-dimmer: light-dark(#7b858f, #7e878f);
  --fsio-dimmest: light-dark(#98a1aa, #646d75);

  /* Meaning. Antique rather than saturated — patina, ochre and oxblood, the
     colours a curio cabinet already has. "bright" means MORE emphatic, which
     on light wood means darker. */
  /* --fsio-on-accent is the ONLY text colour that may sit on an --fsio-accent
     fill: a primary button, the unread badge. --fsio-fg-bright is wrong there
     in light, where "brightest" means darkest and the pair collapses to two
     mid pewters. The dark accent is a shade deeper than it looks like it
     wants to be so the pairing clears AA at badge size — measured 5.36:1
     light, 4.59:1 dark. */
  --fsio-accent: light-dark(#546a78, #5d7284);
  --fsio-accent-hover: light-dark(#455966, #6d8496);
  --fsio-on-accent: light-dark(#f7f9fa, #f2f6f8);
  --fsio-cyan: light-dark(#3f6f78, #8fbfc7);
  --fsio-good: light-dark(#4f7a55, #93b899);
  --fsio-warn: light-dark(#8a6a22, #dcba76);
  --fsio-warn-quiet: light-dark(#9a7c3a, #c7a868);
  --fsio-bad: light-dark(#9b4a46, #c97d79);
  --fsio-bad-bright: light-dark(#8e3f3b, #e79a96);
  --fsio-bad-line: light-dark(#9b4a4673, #6e3f3c);
  --fsio-bad-wash: light-dark(#9b4a461a, #3a2523);

  /* A wash is the faintest a meaning gets: the fill under a banner, the glow
     on a row that just changed. Amber has both a wash and a line because the
     fenced composer needs the pair; blue has only a wash, because the one
     thing that uses it (a file the agent just touched) has no border. */
  --fsio-warn-line: light-dark(#8a6a2266, #6b5a2e);
  --fsio-warn-wash: light-dark(#8a6a2217, #2e2718);
  --fsio-accent-wash: light-dark(#546a781f, #63798a2b);

  /* The one thing that does NOT invert: a terminal is a dark slab in both
     themes, an object sitting in the cabinet rather than a region of the
     page. Keeping it fixed also keeps xterm's 16 ANSI colours legible without
     remapping them per theme. */
  --fsio-slab: #17191c;
  --fsio-slab-fg: #d6dbdf;
  --fsio-slab-dim: #96a6b0;

  /* Glass. "Floating very close to the wood" is the whole brief: a tight
     contact shadow and a short throw, never a drop shadow. */
  --fsio-glass-blur: blur(14px) saturate(1.4);
  --fsio-glass-edge: light-dark(#ffffffbf, #ffffff17);
  --fsio-lift: light-dark(
    0 1px 1px #3a30220f, 0 6px 16px -10px #3a302247,
    0 1px 1px #00000059, 0 6px 16px -10px #0000008c
  );
  --fsio-lift-high: light-dark(
    0 1px 2px #3a302214, 0 18px 40px -18px #3a30225c,
    0 1px 2px #00000073, 0 18px 40px -18px #000000b3
  );

  /* Type. Instrument Serif is a single-weight display face — titles and
     wordmarks only, never a paragraph. */
  --fsio-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --fsio-title: "Instrument Serif", Georgia, "Times New Roman", serif;
  --fsio-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
`;

/** The vocabulary, for a shadow root. Put it first in any `static styles` that
 *  reads a `--fsio-*` variable. */
export const tokens = css`
  :host {
    ${unsafeCSS(VARS)}
  }
`;

/** The same vocabulary at `:root`, for the page skeleton — which is light DOM
 *  and so gets none of the above. Consumed by `theme.ts`; a demo wants
 *  `installPageTheme()`, not this. */
export const rootVars = VARS;

/** A pane of glass. Anything that floats over the wood — a panel, a popover,
 *  a dialog, a bar — is this: translucent, blurred, a lit top edge where it
 *  catches the light, and a shadow tight enough to read as contact rather
 *  than altitude.
 *
 *  The `::before` carries the top edge rather than a `border-top` so it can
 *  be a gradient that fades out along the width, the way a real bevel does. */
export const glass = css`
  .glass {
    background: var(--fsio-panel);
    -webkit-backdrop-filter: var(--fsio-glass-blur);
    backdrop-filter: var(--fsio-glass-blur);
    border: 1px solid var(--fsio-line);
    box-shadow: var(--fsio-lift);
    position: relative;
  }
  .glass::before {
    content: "";
    position: absolute; inset: 0 0 auto; height: 1px;
    background: linear-gradient(90deg, transparent, var(--fsio-glass-edge) 18%, var(--fsio-glass-edge) 82%, transparent);
    pointer-events: none;
  }
  .glass.high { box-shadow: var(--fsio-lift-high); }
`;

/** Material Symbols, Outlined. Outlined over rounded or sharp because the
 *  pewter line weight is what carries the theme — a filled icon would read as
 *  a blob of accent colour, and a rounded one softens a cabinet that is meant
 *  to have edges.
 *
 *  The `@font-face` is document-scoped (installed by `theme.ts`) and reaches
 *  into shadow roots on its own; this rule set is what does NOT — the family,
 *  the ligature switch and the variable axes have to be declared in every
 *  root that draws an icon.
 *
 *  Usage is the ligature form: `<span class="icon">close</span>`. */
export const icons = css`
  .icon {
    font-family: "Material Symbols Outlined";
    font-weight: normal; font-style: normal; line-height: 1;
    letter-spacing: normal; text-transform: none; white-space: nowrap;
    word-wrap: normal; direction: ltr;
    -webkit-font-feature-settings: "liga";
    font-feature-settings: "liga";
    -webkit-font-smoothing: antialiased;
    font-size: 1.15em; flex: none;
    /* FILL 0, weight 300: a thin outline, because everything else on the page
       is a hairline too. GRAD -25 compensates for the optical thickening a
       dark icon gets on light wood. */
    font-variation-settings: "FILL" 0, "wght" 300, "GRAD" -25, "opsz" 24;
    user-select: none;
  }
  .icon.fill { font-variation-settings: "FILL" 1, "wght" 300, "GRAD" -25, "opsz" 24; }
  .icon.sm { font-size: 1em; }
  .icon.lg { font-size: 1.4em; }
`;

/** Buttons and the row they sit in. Four variants, and they mean things:
 *  `primary` is the one gesture a panel is FOR, `ghost` is the way out of it,
 *  `danger` is the one that does not come back, plain is everything else.
 *
 *  Plain buttons are glass like everything else — same translucency, same lit
 *  edge — which is why they carry a backdrop filter rather than a fill. */
export const controls = css`
  button {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 7px;
    padding: 0.45rem 1rem; font: inherit; font-family: var(--fsio-sans);
    cursor: pointer; box-shadow: var(--fsio-lift);
    -webkit-backdrop-filter: var(--fsio-glass-blur);
    backdrop-filter: var(--fsio-glass-blur);
    transition: background 90ms ease, border-color 90ms ease;
  }
  button:hover { background: var(--fsio-control-hover); border-color: var(--fsio-line-control); }
  button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 2px; }
  button.primary {
    background: var(--fsio-accent); border-color: var(--fsio-accent);
    color: var(--fsio-on-accent); font-weight: 600;
  }
  button.primary:hover { background: var(--fsio-accent-hover); border-color: var(--fsio-accent-hover); }
  button.small { font-size: 0.8rem; padding: 0.2rem 0.6rem; }
  button.ghost {
    background: none; border: none; color: var(--fsio-accent); padding: 0.2rem 0.3rem;
    box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  button.ghost:hover { background: none; text-decoration: underline; }
  button.danger { border-color: var(--fsio-bad-line); color: var(--fsio-bad-bright); }
  button.danger:hover { background: var(--fsio-bad-wash); border-color: var(--fsio-bad); }
  .row {
    display: flex; align-items: center; gap: 0.7rem;
    flex-wrap: wrap; margin-top: 1rem;
  }
`;

/** Prose weights. `explain` is what a panel says, `fineprint` is what it
 *  admits, `hint` is the second line of anything. */
export const prose = css`
  code, pre { font-family: var(--fsio-mono); }
  .explain { color: var(--fsio-dim); font-size: 0.9rem; margin: 0.2rem 0 0.8rem; }
  .fineprint { color: var(--fsio-dimmer); font-size: 0.82rem; margin: 0.5rem 0 0; }
  .fineprint code { font-size: 0.78rem; }
  .hint { color: var(--fsio-dim); font-size: 0.85rem; display: block; margin-top: 0.15rem; }
`;

/** Three verdicts a page gives about itself while you wait: it worked, it is
 *  still waiting, it did not work.
 *
 *  These were emoji, which meant three glyphs the theme could not reach —
 *  a green tick stays a green tick on ash. They are Material Symbols now, and
 *  they take the pewter with them. */
export const statusLines = css`
  .status {
    font-size: 0.9rem; margin-top: 0.7rem;
    display: flex; align-items: flex-start; gap: 0.4rem;
  }
  .status::before {
    font-family: "Material Symbols Outlined"; font-size: 1.15em;
    font-variation-settings: "FILL" 0, "wght" 300, "GRAD" -25, "opsz" 24;
    -webkit-font-feature-settings: "liga"; font-feature-settings: "liga";
    -webkit-font-smoothing: antialiased; line-height: 1.35; flex: none;
  }
  .status.ok::before { content: "check_circle"; color: var(--fsio-good); }
  .status.wait::before { content: "hourglass_top"; color: var(--fsio-warn); }
  .status.bad::before { content: "error"; color: var(--fsio-bad); }
  .status .hint { color: var(--fsio-dim); font-size: 0.85rem; display: block; margin-top: 0.15rem; }
`;

/** A popover surface. The box a list of sessions arrives in, on both pages —
 *  and the first thing on either page that is literally glass. */
export const panel = css`
  .pop {
    background: var(--fsio-float);
    -webkit-backdrop-filter: var(--fsio-glass-blur);
    backdrop-filter: var(--fsio-glass-blur);
    border: 1px solid var(--fsio-line-strong);
    border-radius: 10px; padding: 0.7rem 0.9rem;
    box-shadow: var(--fsio-lift-high);
    width: min(34rem, 92vw); max-height: 60vh; overflow: auto;
    line-height: 1.45;
  }
`;

/** What goes IN one — and unprefixed, because the content of a popover is
 *  slotted from the demo that owns the words, where no `.pop` ancestor
 *  exists to hang a descendant selector on. */
export const listBody = css`
  h3 {
    margin: 0.7rem 0 0.2rem; font-size: 0.95rem; color: var(--fsio-cyan);
    font-family: var(--fsio-title); font-weight: 400; letter-spacing: 0.01em;
  }
  h3:first-child { margin-top: 0; }
  .explain { color: var(--fsio-dimmer); margin: 0 0 0.6rem; font-size: 0.8rem; }
  button {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 6px;
    padding: 0.25rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer;
    box-shadow: var(--fsio-lift);
  }
  button:hover { background: var(--fsio-control-hover); }
  button.primary {
    background: var(--fsio-accent); border-color: var(--fsio-accent); color: var(--fsio-on-accent);
  }
  button.primary:hover { background: var(--fsio-accent-hover); }
  button.wide { width: 100%; margin-top: 0.6rem; }
`;

/** What goes in the corner "i": headings, fixed-width dumps, a grid of
 *  counters. Unprefixed for the same reason `listBody` is — this content is
 *  slotted from the demo that owns it. */
export const diagBody = css`
  h3 {
    margin: 0.6rem 0 0.2rem; font-size: 0.95rem; color: var(--fsio-cyan);
    font-family: var(--fsio-title); font-weight: 400; letter-spacing: 0.01em;
  }
  h3:first-child { margin-top: 0; }
  p { color: var(--fsio-dim); margin: 0 0 0.7rem; }
  em { color: var(--fsio-fg); font-style: normal; font-weight: 600; }
  a { color: var(--fsio-accent); }
  code { font-family: var(--fsio-mono); font-size: 0.78rem; }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--fsio-mono); color: var(--fsio-dim);
  }
  /* The page log is a dark slab for the same reason the terminal is: it is
     machine output, and it reads as an object rather than as part of the
     page. Fixed in both themes. */
  pre.log {
    background: var(--fsio-slab); border-radius: 7px; padding: 0.8rem;
    border: 1px solid var(--fsio-line-strong);
    margin: 0.4rem 0 0; overflow: auto; white-space: pre; word-break: normal;
    font-size: 0.75rem; line-height: 1.45; max-height: 11rem; color: var(--fsio-slab-dim);
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.15rem 0.8rem; }
  summary { cursor: pointer; color: var(--fsio-accent); font-size: 0.82rem; }
  .foot { color: var(--fsio-dimmest); font-size: 0.78rem; margin-top: 0.8rem; }
  button.small {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 5px;
    padding: 0.15rem 0.6rem; font: inherit; font-size: 0.78rem; cursor: pointer;
  }
  button.small:hover { background: var(--fsio-control-hover); }
`;

/** The setup dialog's own chrome: the modal, its backdrop, the wordmark and
 *  the breadcrumb trail. Both wizards had all of it, to the pixel.
 *
 *  This is the one place Instrument Serif does real work — the wordmark is
 *  the page's title, and a curio cabinet has a label on it. */
export const dialogChrome = css`
  dialog {
    background: var(--fsio-float); color: var(--fsio-fg);
    -webkit-backdrop-filter: var(--fsio-glass-blur);
    backdrop-filter: var(--fsio-glass-blur);
    border: 1px solid var(--fsio-line-strong); border-radius: 14px;
    box-shadow: var(--fsio-lift-high);
    padding: 1.4rem 1.6rem; width: min(36rem, 92vw);
    font: inherit; font-family: var(--fsio-sans); line-height: 1.5;
  }
  dialog::backdrop {
    background: light-dark(#3a302233, #0000005c);
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  }
  h1 {
    font-family: var(--fsio-title); font-size: 1.9rem; margin: 0;
    font-weight: 400; letter-spacing: 0.005em; color: var(--fsio-fg-bright);
  }
  h1 .dim { color: var(--fsio-accent); font-weight: 400; }
  h2 {
    font-family: var(--fsio-title); font-size: 1.35rem; margin: 0 0 0.3rem;
    font-weight: 400; color: var(--fsio-fg-bright);
  }
  .tagline { color: var(--fsio-dim); margin: 0.2rem 0 1.1rem; font-size: 0.92rem; }
  .crumbs {
    display: flex; gap: 1rem; font-size: 0.8rem;
    color: var(--fsio-dimmest); margin-bottom: 0.9rem;
  }
  .crumbs .on { color: var(--fsio-cyan); }
  .crumbs .done { color: var(--fsio-good); }
  /* The hard stop — a browser without File System Access — used to be three
     lines of markup each demo wrote for itself and two rules here to colour
     them. It is fsio-gate now, with its own shadow root, so those rules went
     with the markup they were styling.

     (No backticks in a comment inside a css template literal: they close the
     template. Cost two builds this session.) */
`;

/** Everything a demo's own wizard body needs, in one import. The frame owns
 *  the dialog; this is for the content the demo slots into it, which lives in
 *  the demo's shadow root and so cannot inherit the frame's rules. */
export const wizardStyles = [tokens, controls, prose, statusLines, dialogChrome, icons];
