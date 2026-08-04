// The workspace pane: the folder, most-recently-changed first, with a fade
// on anything that moved while you were watching.
//
// Nothing here goes through fsio. It is the same directory handle the
// transport rides on, read directly by the page — which is the argument the
// demo is making: one grant, two uses, and no server anywhere. When the
// agent edits a file, the row jumps to the top and lights up next to the
// sentence where it said it would.
//
// The row and its fade are `@fsio/ui`'s now (`<fsio-file-row>`, `Ticker`):
// the actuator demo's files pane had copied both out of this file, which is
// the duplication rule 6 waits for. What stays here is that this pane is a
// *feed* — you watch it, you do not click it.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, tokens, Ticker } from "@fsio/ui";
import { agentFacts, files, workspaceNote, workspaceOpen } from "../state";

class AcpWorkspace extends SignalWatcher(LitElement) {
  // The rows say how long ago on wall-clock time, and the fade expires on it
  // too, so re-render on a slow tick rather than only when something changes.
  #ticker = new Ticker(this);

  static override styles = [
    tokens,
    css`
      :host {
        display: flex; flex-direction: column; min-height: 0;
        border-left: 1px solid var(--fsio-line); background: var(--fsio-aside);
      }
      header {
        padding: 0.5rem 0.8rem; font-size: 0.78rem; color: var(--fsio-dimmer);
        border-bottom: 1px solid var(--fsio-line);
        display: flex; justify-content: space-between; gap: 0.5rem;
      }
      .rows { padding: 0.3rem 0; overflow-y: auto; flex: 1; }
      footer {
        padding: 0.5rem 0.8rem; font-size: 0.72rem; color: var(--fsio-dimmest);
        border-top: 1px solid var(--fsio-line);
      }
      /* Narrow: this stops being a column and becomes a drawer over the
         conversation, opened from the bar. The breakpoint matches the grid's
         in index.html — one number, said in two places, because the layout
         lives out there and the drawer lives in here. */
      @media (max-width: 800px) {
        :host {
          position: absolute; inset: 0 0 0 auto; width: min(20rem, 88vw); z-index: 4;
          box-shadow: var(--fsio-lift);
          transform: translateX(100%); transition: transform 180ms ease-out;
        }
        :host([data-open]) { transform: none; }
      }
      @media (prefers-reduced-motion: reduce) { :host { transition: none; } }
    `,
  ];

  override render(): TemplateResult {
    const rows = files.get();
    const facts = agentFacts.get();
    const now = Date.now();
    // An attribute rather than a bound property: this element sits in the
    // page's light DOM (index.html), so nothing is binding to it — it reads
    // the signal itself, the way it already reads `files`.
    this.toggleAttribute("data-open", workspaceOpen.get());
    return html`
      <header><span>workspace</span><span>${workspaceNote.get()}</span></header>
      <div class="rows" role="list">
        ${rows.map(
          (r) => html`<fsio-file-row
            .path=${r.path}
            .meta=${ago(now - r.modified)}
            .hotSince=${r.seenChanged}
            .now=${now}
            title=${r.path}
          ></fsio-file-row>`
        )}
      </div>
      ${facts ? html`<footer>this list is read directly by the page, through your folder grant.</footer>` : nothing}
    `;
  }
}

customElements.define("acp-workspace", AcpWorkspace);
