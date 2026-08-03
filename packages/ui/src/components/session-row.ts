// One session, offered. The row a person picks a session out of.
//
// There were four of these across the two pages — the agent page's arrival
// panel and its "+" list, twice, and the terminal's resume picker — and every
// one of them was a name, a line about where that session is and who is
// holding it, and a button. What differed was the words, so the words are
// props and nothing else is.
//
// The `quote` line is the one worth keeping when a row gets tight: an id and
// a timestamp are a list of hashes, and what a person actually recognises a
// session by is what it was saying.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { tokens } from "../tokens.js";

class FsioSessionRow extends LitElement {
  static override properties = {
    name: {},
    note: {},
    meta: {},
    quote: {},
    flag: {},
    action: {},
    hint: {},
    primary: { type: Boolean },
    disabled: { type: Boolean },
    boxed: { type: Boolean },
  };

  /** What to call it — a friendly name, or an agent's name. */
  name = "";
  /** A quieter fact beside the name (a version, say). */
  note = "";
  /** Where it is and who holds it: the line the choice is actually made on. */
  meta = "";
  /** The last thing it said, ellipsized. Full text lands in the tooltip. */
  quote = "";
  /** Something amber the person should read before choosing — a session that
   *  is blocked, or otherwise not straightforwardly joinable. */
  flag = "";
  /** The button's label. Empty means this row is not offering anything. */
  action = "";
  /** Tooltip for the button, when the label alone undersells the gesture. */
  hint = "";
  primary = false;
  disabled = false;
  /** Draw a border around the row. On its own in a dialog it wants one; in a
   *  list of rows under a heading the separators do the work. */
  boxed = false;

  static override styles = [
    tokens,
    css`
      :host {
        display: flex; align-items: center; gap: 0.8rem;
        padding: 0.4rem 0; border-top: 1px solid var(--fsio-line);
      }
      :host([boxed]) {
        border: 1px solid var(--fsio-line-strong); border-radius: 8px;
        padding: 0.6rem 0.8rem; margin: 0.5rem 0;
      }
      .who { flex: 1; min-width: 0; }
      .name { color: var(--fsio-fg-bright); font-weight: 500; }
      .note { color: var(--fsio-dimmer); font-size: 0.82rem; }
      .meta { color: var(--fsio-dimmer); font-size: 0.82rem; margin-top: 0.1rem; }
      .quote {
        color: var(--fsio-dimmer); font-size: 0.82rem; margin-top: 0.25rem;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        border-left: 2px solid var(--fsio-line-strong); padding-left: 0.5rem;
      }
      .flag { color: var(--fsio-warn-quiet); font-size: 0.82rem; margin-top: 0.25rem; }
      button {
        background: var(--fsio-control); color: var(--fsio-fg);
        border: 1px solid var(--fsio-line-control); border-radius: 6px;
        padding: 0.25rem 0.7rem; font: inherit; font-size: 0.82rem;
        cursor: pointer; flex: none;
      }
      button:hover { background: var(--fsio-control-hover); }
      button.primary {
        background: var(--fsio-accent); border-color: var(--fsio-accent);
        color: var(--fsio-fg-bright);
      }
      button.primary:hover { background: var(--fsio-accent-hover); }
      button[disabled] { opacity: 0.5; cursor: default; }
      button[disabled]:hover { background: var(--fsio-control); }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <span class="who">
        <span class="name">${this.name}</span>${this.note
          ? html`<span class="note"> ${this.note}</span>`
          : nothing}
        ${this.meta ? html`<div class="meta">${this.meta}</div>` : nothing}
        ${this.quote ? html`<div class="quote" title=${this.quote}>${this.quote}</div>` : nothing}
        ${this.flag ? html`<div class="flag">${this.flag}</div>` : nothing}
      </span>
      ${this.action
        ? html`<button
            class=${this.primary ? "primary" : ""}
            title=${this.hint}
            ?disabled=${this.disabled}
            @click=${() => this.dispatchEvent(new CustomEvent("action", { bubbles: true, composed: true }))}
          >${this.action}</button>`
        : nothing}
    `;
  }
}

customElements.define("fsio-session-row", FsioSessionRow);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-session-row": FsioSessionRow;
  }
}
