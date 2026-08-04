// The "i" in the corner: what the page knows about itself.
//
// Nothing in here is needed to use the page — it is needed when the page is
// behaving oddly. That is the whole placement argument. The terminal kept this
// material in a status bar along the bottom, at the same weight as the facts
// about what you are working on; the agent page moved it to a corner and got
// the bar back. This is the corner, and the terminal's bar went away with it.
//
// ## What the popover renders itself, and why it is not everything
//
// It started as one slot and nothing else, on the grounds that which facts a
// demo has is the demo's business. That held for the facts and stopped holding
// underneath them: all three pages ended the popover with the same two
// sections — the theme switch, then the page log — and the three copies had
// drifted to three different qualities. One had a copy button and pinned the
// log to its last line; one had neither; one had put the theme switch up in
// the header instead, where it sat at the weight of the folder you are working
// in. So the tail is this component's now, which also settles where a person
// looks for the theme: same corner, same place in it, on every page.
//
// The line is the usual one. Pinning a scroll and copying to the clipboard are
// mechanics; a page log is a page log on all three. What a person is *looking
// at* is prose, differs per demo, and stays slotted — above the tail in the
// default slot, or below it in `foot`.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { Dismiss } from "../dismiss.js";
import { tokens, panel, icons, diagBody } from "../tokens.js";
import "./theme-switch.js";

class FsioDetails extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
    log: {},
  };

  open = false;
  /** The button's tooltip. Say what is inside, not "details". */
  label = "what this page knows about itself";
  /** The page's own log, newest last. Empty draws no log section at all — a
   *  page that does not keep one should not show an empty slab. */
  log = "";

  constructor() {
    super();
    new Dismiss(this, () => this.open, () => { this.open = false; });
  }

  static override styles = [
    tokens,
    panel,
    icons,
    // The two sections below are rendered in here rather than slotted, so this
    // root needs the same vocabulary the demos get for their slotted content.
    diagBody,
    css`
      :host {
        position: fixed; right: 0.6rem; bottom: 0.6rem; z-index: 20;
        font-size: 0.85rem;
      }
      .i {
        display: flex; align-items: center; justify-content: center;
        width: 1.5rem; height: 1.5rem; border-radius: 50%;
        background: var(--fsio-panel); border: 1px solid var(--fsio-line-strong);
        -webkit-backdrop-filter: var(--fsio-glass-blur);
        backdrop-filter: var(--fsio-glass-blur);
        box-shadow: var(--fsio-lift);
        color: var(--fsio-dimmer);
        cursor: pointer; padding: 0; line-height: 1;
      }
      .i:hover, .i:focus-visible, .i.on {
        color: var(--fsio-cyan); border-color: var(--fsio-control-hover);
        background: var(--fsio-panel);
      }
      /* Upward, and pinned by its bottom edge rather than its top, so a tall
         page log grows away from the button instead of over it. The cap is
         what keeps a long slotted essay from running off the top of the
         viewport, where there is no way to scroll it back. */
      .pop {
        position: fixed; right: 0.6rem; bottom: 2.4rem;
        width: min(38rem, 92vw); font-size: 0.8rem;
        max-height: calc(100vh - 3.6rem); overflow-y: auto;
      }
      /* The log's heading carries its own control, so the two share a line
         instead of the button starting a new one under the word. */
      .logHead {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 0.6rem;
      }
      .logHead h3 { margin-bottom: 0; }
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
      ><span class="icon sm">info</span></button>
      ${this.open
        ? html`<div class="pop">
            <slot></slot>
            <h3>appearance</h3>
            <fsio-theme-switch></fsio-theme-switch>
            ${this.log
              ? html`<div class="logHead">
                    <h3>page log</h3>
                    <button class="small" @click=${this.#copy}>copy log</button>
                  </div>
                  <pre class="log">${this.log}</pre>`
              : nothing}
            <slot name="foot"></slot>
          </div>`
        : nothing}
    `;
  }

  /** The log is read newest-first in practice, so it opens at its last line.
   *  Re-pinned on every render because the log grows while the popover is
   *  open — a page worth opening this on is a page that is still logging. */
  protected override updated(): void {
    const pre = this.renderRoot.querySelector("pre.log");
    if (pre) pre.scrollTop = pre.scrollHeight;
  }

  #copy = (): void => {
    void navigator.clipboard.writeText(this.log);
  };
}

customElements.define("fsio-details", FsioDetails);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-details": FsioDetails;
  }
}
