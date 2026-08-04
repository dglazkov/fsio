// The bar across the top: which folder this page is holding, and what is open
// in it.
//
// All three pages had written this, down to the same comment about the strip's
// spacer. Two of them had it as a component (`acp-top-bar`, `fsio-top-bar`)
// with byte-identical `:host` and `.name` rules; the third had a third copy of
// those rules inline in its app shell's `<header>`. The layout is one
// statement read left to right — *this folder, and what is open in it* — and
// three pages agreeing on it that precisely is what rule 6 calls a library.
//
// Mechanics here, prose there, as usual. The bar owns the row: the surface,
// the glass, the rule underneath, and the fact that the middle slot is the one
// that stretches and scrolls. What the folder is called, what a chip means,
// and which conditions are worth a word on the right — all slotted.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { tokens } from "../tokens.js";

class FsioTopBar extends LitElement {
  static override properties = {
    name: {},
    suffix: {},
  };

  /** What this page is holding, already punctuated by the page: the demos
   *  that name a folder pass `myproject/`, and the one that has not got one
   *  yet passes its own placeholder. This component never adds the slash —
   *  "fsio terminal/" would be a folder that does not exist. */
  name = "";
  /** A quieter trailing word, for a page whose title is the folder *and*
   *  something else ("fsio" + "/ actuator"). Empty on the pages whose title
   *  is just the folder. */
  suffix = "";

  static override styles = [
    tokens,
    css`
      :host {
        display: flex; align-items: center; gap: 0.7rem;
        padding: 0.35rem 0.9rem; background: var(--fsio-panel);
        -webkit-backdrop-filter: var(--fsio-glass-blur);
        backdrop-filter: var(--fsio-glass-blur);
        border-bottom: 1px solid var(--fsio-line); font-size: 0.85rem;
        position: relative; z-index: 3;
      }
      .name {
        font-family: var(--fsio-title); font-weight: 400; font-size: 1.15rem;
        color: var(--fsio-fg-bright); flex: none; line-height: 1.2;
        white-space: nowrap;
      }
      .suffix { color: var(--fsio-dimmest); flex: none; }
      /* The middle takes the row and does its own pushing: a tab strip's
         internal spacer is what keeps "+" beside the last chip instead of at
         the far right, so this row needs no spacer of its own. One here would
         be a second flex:1 sibling splitting the free space with the strip —
         which is what once left the chips scrolling inside half a header with
         an empty div next to them. */
      ::slotted(*) { flex: 1; min-width: 0; }
      /* Whatever the page thinks is worth saying on the right: a heartbeat
         that stopped, a session that was rejoined. Quiet, and never the thing
         that stretches. */
      ::slotted([slot="status"]) { flex: none; }
      slot[name="status"] { display: contents; }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <span class="name">${this.name}</span>
      ${this.suffix ? html`<span class="suffix">${this.suffix}</span>` : nothing}
      <slot></slot>
      <slot name="status"></slot>
    `;
  }
}

customElements.define("fsio-top-bar", FsioTopBar);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-top-bar": FsioTopBar;
  }
}
