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
import { agentFacts, files, workspaceNote } from "../state";

/** How long a changed file stays highlighted. */
const GLOW_MS = 12_000;

class AcpWorkspace extends SignalWatcher(LitElement) {
  #tick: ReturnType<typeof setInterval> | undefined;

  static override styles = css`
    :host {
      display: flex; flex-direction: column; min-height: 0;
      border-left: 1px solid #262b34; background: #171a20;
    }
    header {
      padding: 0.5rem 0.8rem; font-size: 0.78rem; color: #7b8598;
      border-bottom: 1px solid #262b34; display: flex; justify-content: space-between; gap: 0.5rem;
    }
    ul { list-style: none; margin: 0; padding: 0.3rem 0; overflow-y: auto; flex: 1; }
    li {
      display: flex; justify-content: space-between; gap: 0.6rem;
      padding: 0.22rem 0.8rem; font-size: 0.8rem; color: #9aa5b8;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    li.hot { color: #eceff4; background: #23303a; }
    li .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
    li .meta { color: #5c6675; white-space: nowrap; }
    li.hot .meta { color: #88c0d0; }
    footer { padding: 0.5rem 0.8rem; font-size: 0.72rem; color: #5c6675; border-top: 1px solid #262b34; }
  `;

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

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

customElements.define("acp-workspace", AcpWorkspace);
