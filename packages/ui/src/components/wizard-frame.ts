// Setup, as a modal over the empty app.
//
// Both pages open the same way: a wordmark, a sentence saying what the thing
// is, a breadcrumb trail, and one panel at a time — run the helper, pick the
// folder, and then it dissolves. The panels say different things; the frame
// around them was written twice.
//
// Setup is not skippable, so Escape is swallowed by default. `dismissible`
// is the exception both pages needed exactly once: a panel that has already
// done its job (a picker with something behind it) should close like any
// other dialog.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { tokens, dialogChrome } from "../tokens.js";

/** One step in the trail. `done` for a step the page has watched happen
 *  rather than asked about — a fact, not a step. */
export interface Crumb {
  label: string;
  state?: "" | "on" | "done";
}

class FsioWizardFrame extends LitElement {
  static override properties = {
    open: { type: Boolean },
    product: {},
    edition: {},
    tagline: {},
    crumbs: { attribute: false },
    dismissible: { type: Boolean },
  };

  open = false;
  product = "fsio";
  /** The half after the slash: which demo this is. */
  edition = "";
  tagline = "";
  /** Empty array draws no trail — a single-panel state (a gate, a reconnect
   *  offer) has no steps to be partway through. */
  crumbs: Crumb[] = [];
  /** Escape closes this dialog. Off by default: setup is not skippable. */
  dismissible = false;

  static override styles = [tokens, dialogChrome, css`
    :host { display: contents; }
  `];

  override render(): TemplateResult {
    return html`<dialog @cancel=${this.#onCancel}>
      ${this.edition || this.tagline
        ? html`<header>
            <h1>${this.product} <span class="dim">/ ${this.edition}</span></h1>
            ${this.tagline ? html`<p class="tagline">${this.tagline}</p>` : nothing}
          </header>`
        : nothing}
      ${this.crumbs.length
        ? html`<div class="crumbs">
            ${this.crumbs.map((c) => html`<span class=${c.state ?? ""}>${c.label}</span>`)}
          </div>`
        : nothing}
      <slot></slot>
    </dialog>`;
  }

  // The dialog element is stable across renders; only its contents swap. So
  // open/close is driven here rather than by rebuilding it, which is also
  // what keeps focus from jumping every time a panel changes.
  protected override updated(): void {
    const d = this.renderRoot.querySelector("dialog")!;
    if (this.open && !d.open) d.showModal();
    else if (!this.open && d.open) d.close();
  }

  #onCancel(e: Event): void {
    if (this.dismissible) {
      this.dispatchEvent(new CustomEvent("dismiss", { bubbles: true, composed: true }));
    }
    // Prevented either way: the demo decides what dismissing means, and a
    // dialog that closed itself first would have already lost the argument.
    e.preventDefault();
  }
}

customElements.define("fsio-wizard-frame", FsioWizardFrame);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-wizard-frame": FsioWizardFrame;
  }
}
