// The palette and the handful of rules that were written out longhand in
// every component of both pages.
//
// These are `css` fragments rather than a global stylesheet because every
// component here and in the demos renders into a shadow root, and a shadow
// root sees no page CSS. Custom properties DO cross that boundary, so
// `tokens` only has to be in scope somewhere above a rule that reads one —
// but putting it first in each component's `static styles` is one line and
// removes the question.
//
// The values are acp-demo's. The two pages had drifted a shade apart — bars
// at #1c1f26 over #2c313c borders in the terminal, #14161a over #262b34 in
// the agent — and one of the two had to win for a token to mean anything.
import { css } from "lit";

/** The vocabulary. Named for the job, never for the colour: `--fsio-bad` can
 *  stop being red, `--fsio-red` cannot stop being red. */
export const tokens = css`
  :host {
    /* surfaces, darkest first */
    --fsio-bg: #14161a;
    --fsio-raised: #191c22;
    --fsio-aside: #171a20;
    --fsio-panel: #1c1f26;
    --fsio-control: #2e3440;
    --fsio-control-hover: #3b4252;

    /* lines */
    --fsio-line: #262b34;
    --fsio-line-strong: #2c313c;
    --fsio-line-control: #4c566a;

    /* text, brightest first */
    --fsio-fg-bright: #eceff4;
    --fsio-fg: #d8dee9;
    --fsio-dim: #9aa5b8;
    --fsio-dimmer: #7b8598;
    --fsio-dimmest: #5c6675;

    /* meaning */
    --fsio-accent: #5e81ac;
    --fsio-accent-hover: #6d8fb8;
    --fsio-cyan: #88c0d0;
    --fsio-good: #a3be8c;
    --fsio-warn: #ebcb8b;
    --fsio-warn-quiet: #d9b477;
    --fsio-bad: #bf616a;
    --fsio-bad-bright: #ef8a95;
    --fsio-bad-line: #6b3b40;
    --fsio-bad-wash: #3b2226;

    --fsio-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
`;

/** Buttons and the row they sit in. Four variants, and they mean things:
 *  `primary` is the one gesture a panel is FOR, `ghost` is the way out of it,
 *  `danger` is the one that does not come back, plain is everything else. */
export const controls = css`
  button {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 6px;
    padding: 0.45rem 1rem; font: inherit; cursor: pointer;
  }
  button:hover { background: var(--fsio-control-hover); }
  button.primary {
    background: var(--fsio-accent); border-color: var(--fsio-accent);
    color: var(--fsio-fg-bright); font-weight: 600;
  }
  button.primary:hover { background: var(--fsio-accent-hover); }
  button.small { font-size: 0.8rem; padding: 0.2rem 0.6rem; }
  button.ghost {
    background: none; border: none; color: #81a1c1; padding: 0.2rem 0.3rem;
  }
  button.ghost:hover { background: none; text-decoration: underline; }
  button.danger { border-color: var(--fsio-bad-line); color: var(--fsio-bad-bright); }
  button.danger:hover { background: var(--fsio-bad-wash); color: #ffd7db; }
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
 *  still waiting, it did not work. */
export const statusLines = css`
  .status { font-size: 0.9rem; margin-top: 0.7rem; }
  .status.ok::before { content: "✅ "; }
  .status.wait::before { content: "⏳ "; }
  .status.bad::before { content: "❌ "; }
  .status .hint { color: var(--fsio-dim); font-size: 0.85rem; display: block; margin-top: 0.15rem; }
`;

/** A popover surface. The box a list of sessions arrives in, on both pages. */
export const panel = css`
  .pop {
    background: var(--fsio-panel); border: 1px solid var(--fsio-line-strong);
    border-radius: 8px; padding: 0.7rem 0.9rem;
    width: min(34rem, 92vw); max-height: 60vh; overflow: auto;
    line-height: 1.45;
  }
`;

/** What goes IN one — and unprefixed, because the content of a popover is
 *  slotted from the demo that owns the words, where no `.pop` ancestor
 *  exists to hang a descendant selector on. */
export const listBody = css`
  h3 { margin: 0.7rem 0 0.2rem; font-size: 0.82rem; color: var(--fsio-cyan); font-weight: 600; }
  h3:first-child { margin-top: 0; }
  .explain { color: var(--fsio-dimmer); margin: 0 0 0.6rem; font-size: 0.8rem; }
  button {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 6px;
    padding: 0.25rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer;
  }
  button:hover { background: var(--fsio-control-hover); }
  button.primary {
    background: var(--fsio-accent); border-color: var(--fsio-accent); color: var(--fsio-fg-bright);
  }
  button.primary:hover { background: var(--fsio-accent-hover); }
  button.wide { width: 100%; margin-top: 0.6rem; }
`;

/** What goes in the corner "i": headings, fixed-width dumps, a grid of
 *  counters. Unprefixed for the same reason `listBody` is — this content is
 *  slotted from the demo that owns it. */
export const diagBody = css`
  h3 { margin: 0.6rem 0 0.2rem; font-size: 0.82rem; color: var(--fsio-cyan); font-weight: 600; }
  h3:first-child { margin-top: 0; }
  p { color: var(--fsio-dim); margin: 0 0 0.7rem; }
  em { color: var(--fsio-fg); font-style: normal; font-weight: 600; }
  a { color: #81a1c1; }
  code { font-family: var(--fsio-mono); font-size: 0.78rem; }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--fsio-mono); color: var(--fsio-dim);
  }
  pre.log {
    background: var(--fsio-bg); border-radius: 6px; padding: 0.8rem;
    margin: 0.4rem 0 0; overflow: auto; white-space: pre; word-break: normal;
    font-size: 0.75rem; line-height: 1.45; max-height: 11rem; color: #81a1c1;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.15rem 0.8rem; }
  summary { cursor: pointer; color: #81a1c1; font-size: 0.82rem; }
  .foot { color: var(--fsio-dimmest); font-size: 0.78rem; margin-top: 0.8rem; }
  button.small {
    background: var(--fsio-control); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-control); border-radius: 5px;
    padding: 0.15rem 0.6rem; font: inherit; font-size: 0.78rem; cursor: pointer;
  }
  button.small:hover { background: var(--fsio-control-hover); }
`;

/** The setup dialog's own chrome: the modal, its backdrop, the wordmark and
 *  the breadcrumb trail. Both wizards had all of it, to the pixel. */
export const dialogChrome = css`
  dialog {
    background: var(--fsio-panel); color: var(--fsio-fg);
    border: 1px solid var(--fsio-line-strong); border-radius: 12px;
    padding: 1.4rem 1.6rem; width: min(36rem, 92vw);
    font: inherit; line-height: 1.5;
  }
  dialog::backdrop { background: rgba(10, 12, 16, 0.55); backdrop-filter: blur(2px); }
  h1 { font-size: 1.15rem; margin: 0; font-weight: 600; }
  h1 .dim { color: var(--fsio-accent); font-weight: 400; }
  h2 { font-size: 1rem; margin: 0 0 0.3rem; font-weight: 600; color: var(--fsio-fg-bright); }
  .tagline { color: var(--fsio-dim); margin: 0.2rem 0 1.1rem; font-size: 0.92rem; }
  .crumbs {
    display: flex; gap: 1rem; font-size: 0.8rem;
    color: var(--fsio-dimmest); margin-bottom: 0.9rem;
  }
  .crumbs .on { color: var(--fsio-cyan); }
  .crumbs .done { color: var(--fsio-good); }
  /* The hard stop (a browser without File System Access). Louder than an
     error inside the flow, because there is no rest of the flow. */
  .gate strong { color: var(--fsio-bad-bright); }
  .gate .hint { color: #d8b9bc; font-size: 0.9rem; margin-top: 0.4rem; }
`;

/** Everything a demo's own wizard body needs, in one import. The frame owns
 *  the dialog; this is for the content the demo slots into it, which lives in
 *  the demo's shadow root and so cannot inherit the frame's rules. */
export const wizardStyles = [tokens, controls, prose, statusLines, dialogChrome];
