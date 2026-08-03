// The workspace pane: the folder, most-recently-changed first, with a fade
// on anything that moved while you were watching.
//
// Nothing here goes through fsio. It is the same directory handle the
// transport rides on, read directly by the page — which is the argument the
// demo is making: one grant, two uses, and no server anywhere. When the
// agent edits a file, the row jumps to the top and lights up next to the
// sentence where it said it would.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, tokens } from "@fsio/ui";
import { agentFacts, files, workspaceNote } from "../state";

/** How long a changed file stays highlighted. */
const GLOW_MS = 12_000;

class AcpWorkspace extends SignalWatcher(LitElement) {
  #tick: ReturnType<typeof setInterval> | undefined;

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
      ul { list-style: none; margin: 0; padding: 0.3rem 0; overflow-y: auto; flex: 1; }
      li {
        display: flex; justify-content: space-between; gap: 0.6rem;
        padding: 0.22rem 0.8rem; font-size: 0.8rem; color: var(--fsio-dim);
        font-family: var(--fsio-mono);
      }
      li.hot { color: var(--fsio-fg-bright); background: #23303a; }
      li .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
      li .meta { color: var(--fsio-dimmest); white-space: nowrap; }
      li.hot .meta { color: var(--fsio-cyan); }
      footer {
        padding: 0.5rem 0.8rem; font-size: 0.72rem; color: var(--fsio-dimmest);
        border-top: 1px solid var(--fsio-line);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    // The glow expires on wall-clock time, so re-render on a slow tick.
    this.#tick = setInterval(() => this.requestUpdate(), 2000);
  }

  override disconnectedCallback(): void {
    clearInterval(this.#tick);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const rows = files.get();
    const facts = agentFacts.get();
    const now = Date.now();
    return html`
      <header><span>workspace</span><span>${workspaceNote.get()}</span></header>
      <ul>
        ${rows.map(
          (r) => html`<li class=${now - r.seenChanged < GLOW_MS ? "hot" : ""}>
            <span class="path" title=${r.path}>${r.path}</span>
            <span class="meta">${ago(now - r.modified)}</span>
          </li>`
        )}
      </ul>
      ${facts ? html`<footer>this list is read directly by the page, through your folder grant.</footer>` : nothing}
    `;
  }
}

customElements.define("acp-workspace", AcpWorkspace);
