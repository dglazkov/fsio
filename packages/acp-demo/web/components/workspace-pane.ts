// The workspace pane: the folder, as a folder, with a fade on anything that
// moved while you were watching.
//
// Nothing here goes through fsio. It is the same directory handle the
// transport rides on, read directly by the page — which is the argument the
// demo is making: one grant, two uses, and no server anywhere. When the agent
// edits a file, the row lights up next to the sentence where it said it
// would, and the directories above it open themselves so you can see it.
//
// The tree, the row and the fade are `@fsio/ui`'s (`<fsio-file-tree>`): the
// actuator demo's files pane had copied the row and the fade out of this
// file, which is the duplication rule 6 waits for, and both panes wanted the
// hierarchy at the same moment. What stays here is what this pane is FOR —
// the folder the conversation is about.
//
// This pane used to be a feed you watched and could not click, and the
// distinction was worth keeping while there was nothing to click TO. There is
// now: a row opens the file in a tab (files.ts), so the sentence "I edited
// src/state.ts" and the file it edited are one gesture apart.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, tokens, Ticker } from "@fsio/ui";
import type { TreeRow } from "@fsio/ui";
import { agentFacts, fileTabs, files, workspaceNote, workspaceOpen } from "../state";
import { openFile } from "../files";

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
    const rows: TreeRow[] = files.get();
    const facts = agentFacts.get();
    const now = Date.now();
    // An attribute rather than a bound property: this element sits in the
    // page's light DOM (index.html), so nothing is binding to it — it reads
    // the signal itself, the way it already reads `files`.
    this.toggleAttribute("data-open", workspaceOpen.get());
    return html`
      <header><span>workspace</span><span>${workspaceNote.get()}</span></header>
      <div class="rows">
        <fsio-file-tree
          .rows=${rows}
          .now=${now}
          .open=${fileTabs.get().map((t) => t.path)}
          .metaFor=${(r: TreeRow) => ago(now - r.modified)}
          label="files in this folder"
          @open=${(e: CustomEvent<{ path: string }>) => openFile(e.detail.path)}
        ></fsio-file-tree>
      </div>
      ${facts ? html`<footer>read directly by the page, through your folder grant. Click one to open it.</footer>` : nothing}
    `;
  }
}

customElements.define("acp-workspace", AcpWorkspace);
