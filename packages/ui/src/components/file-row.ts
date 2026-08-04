// One file in a pane on the right: what it is called, one fact about it, and
// whatever the page lets you do to it.
//
// Written twice — the agent page's workspace pane and the actuator's files
// pane — and the second says so in its own header comment: "the shape is
// acp-demo's workspace pane, which is where the row layout and the change-fade
// come from." That is the citation rule 6 asks for, so here is the row.
//
// The panes stay where they are. They disagree about what a pane IS — one is a
// feed you watch, the other a picker you click — and that disagreement is real
// enough to leave alone (#157). What they never disagreed about is the row.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { tokens } from "../tokens.js";

/** How long a changed file stays lit. Long enough to catch your eye after you
 *  looked away from the sentence that caused it, short enough that a busy
 *  folder is not a wall of highlight. Both panes had picked 12 s
 *  independently. */
export const GLOW_MS = 12_000;

class FsioFileRow extends LitElement {
  static override properties = {
    path: {},
    meta: {},
    hotSince: { type: Number },
    now: { type: Number },
    current: { type: Boolean, reflect: true },
    interactive: { type: Boolean, reflect: true },
  };

  /** The name, shown tail-first when it does not fit (see the CSS). */
  path = "";
  /** The one fact to the right: how long ago, how big, or both. */
  meta = "";
  /** When this file last changed under us, or 0 for never. The row decides
   *  whether that is still recent — the panes had that arithmetic twice. */
  hotSince = 0;
  /** What time the owner of the clock thinks it is. Passed in rather than
   *  read, because a pane of forty rows should have one interval and not
   *  forty (see `Ticker`). */
  now = 0;
  /** This file is the one already open. */
  current = false;
  /** Clicking the row does something, so it should look like it. */
  interactive = false;

  static override styles = [
    tokens,
    css`
      /* The left padding is a variable because a row in a tree sits at a
         depth (fsio-file-tree sets it); a row in a flat list does not, and
         gets the same 0.8rem it always had. */
      :host {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.2rem 0.5rem 0.2rem var(--fsio-row-indent, 0.8rem);
        font-size: 0.8rem; font-family: var(--fsio-mono);
        color: var(--fsio-dim);
      }
      :host([interactive]) { cursor: pointer; }
      :host([interactive]:hover) { background: var(--fsio-panel); color: var(--fsio-fg-bright); }
      :host([current]) { color: var(--fsio-fg-bright); }
      /* Changed while you were watching. The background is the signal and the
         cyan meta is the confirmation — a file that moved has both, so neither
         has to carry it alone for anyone who cannot separate the two colors. */
      :host(.hot) { color: var(--fsio-fg-bright); background: var(--fsio-accent-wash); }
      :host(.hot) .meta { color: var(--fsio-cyan); }
      /* Motion is a transition here rather than a keyframe, so the reduced
         setting just makes the arrival instant instead of animating it. */
      :host { transition: background-color 400ms ease-out; }
      @media (prefers-reduced-motion: reduce) { :host { transition: none; } }
      /* Tail-first truncation: a path is identified by its end (the file
         name), not its beginning (three folders everything shares), so the
         ellipsis goes on the left. direction:rtl moves the overflow to the
         other end and text-align:left puts the text back where it reads. */
      .path {
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        direction: rtl; text-align: left;
      }
      .meta { flex: none; white-space: nowrap; font-size: 0.72rem; color: var(--fsio-dimmest); }
      /* Controls stay out of sight until the row is under the pointer — and
         come back for the keyboard, which has no pointer to hover with. */
      ::slotted(button) { opacity: 0; flex: none; }
      :host(:hover) ::slotted(button), ::slotted(button:focus-visible) { opacity: 1; }
      @media (hover: none) { ::slotted(button) { opacity: 1; } }
    `,
  ];

  /** A row in a pane is a list item, and — where the page acts on a click —
   *  something the keyboard can reach. The actuator's pane was mouse-only:
   *  every file in the granted folder was one click from a tab and no number
   *  of Tab presses away from anything.
   *
   *  A caller that already said what this row is keeps its answer: inside
   *  `fsio-file-tree` a row is a `treeitem`, and a list item nested in a tree
   *  is a row that lies to a screen reader about the shape it is in. */
  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute("role")) this.setAttribute("role", "listitem");
    if (this.interactive) {
      this.tabIndex = 0;
      this.addEventListener("keydown", this.#key);
    }
  }

  override disconnectedCallback(): void {
    this.removeEventListener("keydown", this.#key);
    super.disconnectedCallback();
  }

  /** Enter and Space do what a click does. The page listens for `click`, so
   *  this synthesizes one rather than inventing a second event for it to
   *  bind — one row, one way to act on it. */
  #key = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== this) return; // a slotted button handles its own keys
    e.preventDefault();
    this.click();
  };

  override render(): TemplateResult {
    // A class rather than a property binding, so the `:host(.hot)` rules above
    // can carry it: reflecting a boolean would work too, but "hot" is derived
    // state and an attribute in the DOM would claim it was set.
    this.classList.toggle("hot", this.hotSince > 0 && this.now - this.hotSince < GLOW_MS);
    return html`
      <span class="path">${this.path}</span>
      <span class="meta">${this.meta}</span>
      <slot></slot>
    `;
  }
}

customElements.define("fsio-file-row", FsioFileRow);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-file-row": FsioFileRow;
  }
}
