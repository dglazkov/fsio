// `<pewter-markdown>` — text an agent wrote, rendered as what it meant.
//
// An agent answers in markdown. Before this, the scaffolded agent screen put
// that text on the page with `textContent +=`, so a person read `**the file**`
// and a fenced block arrived as three backticks and a wall of unwrapped code.
// This is the element that makes the screen show what the agent said.
//
// **It is one property.** A screen sets `.text` and the element does the rest,
// which is what makes it usable while a turn is still streaming: set it again
// with more text and the parse is redone. Re-parsing the whole message on
// every chunk is O(n²) over a message, and a message is a few kilobytes — the
// alternative is an incremental parser holding state across chunks, which is a
// great deal of machinery to make a chat bubble cheaper than free.
//
// **A shadow root, like the rest of the kit**, and that is a deliberate choice
// rather than the default one. Prose is the case with the best argument for
// the light DOM: an author will want `code { }` and `a { }` to mean something.
// It stays in the shadow anyway, because the same reach runs the other way —
// a screen that resets `p { margin: 0 }` for its own layout would silently
// reflow every agent message, and that is the accident the kit's boundary
// exists to prevent. What an author restyles instead is the `--pewter-md-*`
// properties below and the `part=` names, both listed in style.css.
//
// **No `unsafeHTML`, ever.** Every piece of agent text below is a child
// binding that lit escapes. markdown.ts's header says why at length; the
// short version is that the port in this frame is a capability, and a script
// injected through a chat bubble would be holding it.
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";
import { tokens } from "./tokens.js";

/** Render markdown source as lit templates, without an element around it.
 *
 *  Exported because a screen that already has its own bubble — a permission
 *  card, a tool call's detail — wants the prose inside markup it controls,
 *  and wrapping that in a custom element would put a shadow boundary in the
 *  middle of its own layout. The element below is this plus a place to stand. */
export function renderMarkdown(src: string): TemplateResult {
  return html`${parseMarkdown(src).map(block)}`;
}

export class PewterMarkdown extends LitElement {
  static override properties = {
    text: {},
  };

  /** The markdown to show. Set it again with more of it while a turn
   *  streams; an unterminated fence renders as code rather than as
   *  backticks (markdown.ts). */
  text = "";

  static override styles = [
    tokens,
    css`
      :host {
        /* Public names an extension sets from anywhere above the element.
           The private copies are what the rules below read, so a screen that
           sets none of them still gets something readable. */
        --_md-code-bg: var(--pewter-md-code-bg, var(--_wash));
        --_md-code-font: var(--pewter-md-code-font, ui-monospace, SFMono-Regular, Menlo, monospace);
        --_md-gap: var(--pewter-md-gap, 0.75rem);
        --_md-rule: var(--pewter-md-rule, var(--_line));
        --_md-quote: var(--pewter-md-quote, var(--_line-strong));

        display: block;
        /* Prose is text, so it takes the page's own type rather than
           imposing one. Only the shapes below are the kit's business. */
        font: inherit;
        color: inherit;
        /* Inheritance crosses a shadow boundary even though selectors do
           not, so a screen that sets white-space: pre-wrap on the bubble
           around this — the scaffolded agent screen does, for its plain-text
           entries — would have every heading and list item inside inherit
           it. Reset here, and re-established on the paragraph rule below
           where the parser's soft-break decision actually means something. */
        white-space: normal;
      }
      /* The first and last thing in a message should not push the bubble
         around it out of shape. */
      ::slotted(*),
      :first-child {
        margin-top: 0;
      }
      p,
      ul,
      ol,
      blockquote,
      pre,
      h1,
      h2,
      h3,
      h4,
      h5,
      h6 {
        margin: 0 0 var(--_md-gap);
      }
      :last-child {
        margin-bottom: 0;
      }
      /* The soft-break decision from markdown.ts, made visible: a newline an
         agent wrote is a newline on screen. */
      p {
        white-space: pre-wrap;
      }
      h1,
      h2,
      h3,
      h4,
      h5,
      h6 {
        font-weight: 600;
        line-height: 1.25;
      }
      h1 {
        font-size: 1.35em;
      }
      h2 {
        font-size: 1.2em;
      }
      h3 {
        font-size: 1.08em;
      }
      h4,
      h5,
      h6 {
        font-size: 1em;
      }
      code {
        font-family: var(--_md-code-font);
        font-size: 0.92em;
      }
      /* A code span is tinted; a code block is a box. Both read the same
         background, so one property restyles the pair. */
      :not(pre) > code {
        background: var(--_md-code-bg);
        border-radius: 4px;
        padding: 0.1em 0.3em;
      }
      pre {
        background: var(--_md-code-bg);
        border-radius: 8px;
        padding: 0.7rem 0.85rem;
        /* Code does not wrap, so a long line scrolls its own box rather than
           widening the conversation. */
        overflow-x: auto;
      }
      pre code {
        font-size: 0.88em;
        white-space: pre;
      }
      /* Still arriving. Left as a marker rather than a spinner: the block is
         already showing its contents, and what is worth saying is that there
         is more coming. */
      pre[data-open] {
        border-inline-start: 2px solid var(--_md-rule);
      }
      blockquote {
        margin-inline: 0;
        padding-inline-start: 0.8rem;
        border-inline-start: 2px solid var(--_md-quote);
        opacity: 0.85;
      }
      ul,
      ol {
        padding-inline-start: 1.4rem;
      }
      li {
        margin: 0.15rem 0;
      }
      hr {
        border: 0;
        border-top: 1px solid var(--_md-rule);
      }
      a {
        color: inherit;
        text-underline-offset: 0.15em;
      }
    `,
  ];

  override render(): TemplateResult {
    return renderMarkdown(this.text);
  }
}

function block(b: Block): TemplateResult {
  switch (b.kind) {
    case "p":
      return html`<p part="p">${b.children.map(inline)}</p>`;
    case "heading":
      // Six cases spelled out rather than one interpolated tag name: a lit
      // template is static by design, and that is the property doing the
      // security work. A tag name built from parsed input would be the seam
      // this design does not have.
      switch (b.level) {
        case 1:
          return html`<h1 part="heading">${b.children.map(inline)}</h1>`;
        case 2:
          return html`<h2 part="heading">${b.children.map(inline)}</h2>`;
        case 3:
          return html`<h3 part="heading">${b.children.map(inline)}</h3>`;
        case 4:
          return html`<h4 part="heading">${b.children.map(inline)}</h4>`;
        case 5:
          return html`<h5 part="heading">${b.children.map(inline)}</h5>`;
        default:
          return html`<h6 part="heading">${b.children.map(inline)}</h6>`;
      }
    case "code":
      // `data-lang` is display only: an agent-supplied language string is
      // never used to pick anything to run, and there is no highlighter here
      // to hand it to. `data-open` marks a fence the input ended inside.
      return html`<pre part="code" data-lang=${b.lang || nothing} ?data-open=${!b.closed}><code>${b.text}</code></pre>`;
    case "list":
      return b.ordered
        ? html`<ol part="list">
            ${b.items.map((it) => html`<li part="item">${it.map(inline)}</li>`)}
          </ol>`
        : html`<ul part="list">
            ${b.items.map((it) => html`<li part="item">${it.map(inline)}</li>`)}
          </ul>`;
    case "quote":
      return html`<blockquote part="quote">${b.children.map(inline)}</blockquote>`;
    case "hr":
      return html`<hr part="rule" />`;
  }
}

function inline(n: Inline): TemplateResult | string {
  switch (n.kind) {
    case "text":
      return n.text;
    case "code":
      return html`<code part="code-span">${n.text}</code>`;
    case "strong":
      return html`<strong>${n.children.map(inline)}</strong>`;
    case "em":
      return html`<em>${n.children.map(inline)}</em>`;
    case "link":
      // The scheme was allow-listed at parse time (http/https/mailto only).
      // `noopener noreferrer` because the agent chose this destination and
      // the human did not: the new tab gets no handle on this one, and the
      // extension's opaque origin does not travel as a referrer.
      return html`<a part="link" href=${n.href} target="_blank" rel="noopener noreferrer">${n.children.map(inline)}</a>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pewter-markdown": PewterMarkdown;
  }
}
