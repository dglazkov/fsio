// A command to run in a terminal, with the button that saves you retyping it.
//
// Three of these on the two pages — the npx one-liner in each wizard, and the
// install line on every agent the helper knows about — all with the same
// scroll-don't-wrap rule, because a wrapped shell command is one a person has
// to reassemble by eye before they trust it.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { tokens } from "../tokens.js";

class FsioCmd extends LitElement {
  static override properties = {
    command: {},
    copied: { state: true },
  };

  /** The line to run. Shown verbatim; copied verbatim. */
  command = "";
  /** Briefly true after a successful copy. */
  copied = false;

  #timer: ReturnType<typeof setTimeout> | undefined;

  static override styles = [
    tokens,
    css`
      :host { display: block; }
      .cmd {
        display: flex; align-items: center; gap: 0.6rem;
        background: var(--fsio-bg); border-radius: 6px;
        padding: 0.5rem 0.8rem; margin: 0.4rem 0 0.6rem;
      }
      code {
        font-family: var(--fsio-mono); font-size: 0.85rem;
        overflow-x: auto; white-space: nowrap; flex: 1;
      }
      button {
        background: var(--fsio-control); color: var(--fsio-fg);
        border: 1px solid var(--fsio-line-control); border-radius: 6px;
        font: inherit; font-size: 0.8rem; padding: 0.2rem 0.6rem; cursor: pointer;
        flex: none; min-width: 4.2rem;
      }
      button:hover { background: var(--fsio-control-hover); }
      button.done { color: var(--fsio-good); border-color: var(--fsio-good); }
    `,
  ];

  override disconnectedCallback(): void {
    clearTimeout(this.#timer);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`<div class="cmd">
      <code>${this.command}</code>
      <button class=${this.copied ? "done" : ""} @click=${this.#copy}>
        ${this.copied ? "copied" : "copy"}
      </button>
    </div>`;
  }

  // The confirmation is the point of having a button at all: a clipboard
  // write is otherwise completely silent, and the failure mode is somebody
  // pasting the previous thing they copied into a terminal.
  #copy = (): void => {
    void navigator.clipboard.writeText(this.command).then(
      () => {
        this.copied = true;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => { this.copied = false; }, 1600);
      },
      () => {} // a denied clipboard leaves the text on screen to select
    );
  };
}

customElements.define("fsio-cmd", FsioCmd);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-cmd": FsioCmd;
  }
}
