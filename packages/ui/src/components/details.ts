// The "i" in the corner: what the page knows about itself.
//
// Nothing in here is needed to use the page — it is needed when the page is
// behaving oddly. That is the whole placement argument. The terminal kept
// this material in a status bar along the bottom, at the same weight as the
// facts about what you are working on; the agent page moved it to a corner
// and got the bar back. This is the corner, and the terminal's bar goes away
// with it.
//
// Everything inside is slotted: the transport's numbers, the agent's state,
// the fine print about what a person is looking at, the page log. Which of
// those a demo has is the demo's business — the popover only owns being a
// popover.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { Dismiss } from "../dismiss.js";
import { tokens, panel } from "../tokens.js";

class FsioDetails extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
  };

  open = false;
  /** The button's tooltip. Say what is inside, not "details". */
  label = "what this page knows about itself";

  constructor() {
    super();
    new Dismiss(this, () => this.open, () => { this.open = false; });
  }

  static override styles = [
    tokens,
    panel,
    css`
      :host {
        position: fixed; right: 0.6rem; bottom: 0.6rem; z-index: 20;
        font-size: 0.85rem;
      }
      .i {
        display: flex; align-items: center; justify-content: center;
        width: 1.35rem; height: 1.35rem; border-radius: 50%;
        background: var(--fsio-raised); border: 1px solid var(--fsio-line-strong);
        color: var(--fsio-dimmest);
        font: inherit; font-size: 0.78rem; font-weight: 600; font-style: italic;
        font-family: Georgia, "Times New Roman", serif;
        cursor: pointer; padding: 0; line-height: 1;
      }
      .i:hover, .i:focus-visible, .i.on {
        color: var(--fsio-cyan); border-color: var(--fsio-control-hover);
        background: var(--fsio-panel);
      }
      /* Upward, and pinned by its bottom edge rather than its top, so a tall
         page log grows away from the button instead of over it. */
      .pop {
        position: fixed; right: 0.6rem; bottom: 2.4rem;
        width: min(38rem, 92vw); font-size: 0.8rem;
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <button
        class="i ${this.open ? "on" : ""}"
        title=${this.label}
        aria-label="details"
        aria-expanded=${this.open}
        @click=${() => { this.open = !this.open; }}
      >i</button>
      ${this.open ? html`<div class="pop"><slot></slot></div>` : nothing}
    `;
  }
}

customElements.define("fsio-details", FsioDetails);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-details": FsioDetails;
  }
}
