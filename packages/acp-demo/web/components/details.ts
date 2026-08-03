// The diagnostics popover: where the agent's state lives, what the transport
// has moved, and the page's own log.
//
// It was a "details" button in the top bar, sitting in the row that names the
// folder and says whether the helper is alive (#140). That put a debugging
// affordance at the same weight as the facts about what you are working on,
// in the one strip that has to stay readable at a glance. Nothing here is
// needed to use the page — it is needed when the page is behaving oddly — so
// it is an "i" in the corner, out of the way until it is wanted.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { agentFacts, diagnostics, phase } from "../state";
import { logText } from "../reporter";

class AcpDetails extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      position: fixed; right: 0.6rem; bottom: 0.6rem; z-index: 20;
      font-size: 0.85rem;
    }
    .i {
      display: flex; align-items: center; justify-content: center;
      width: 1.35rem; height: 1.35rem; border-radius: 50%;
      background: #191c22; border: 1px solid #2c313c; color: #5c6675;
      font: inherit; font-size: 0.78rem; font-weight: 600; font-style: italic;
      font-family: Georgia, "Times New Roman", serif;
      cursor: pointer; padding: 0; line-height: 1;
    }
    .i:hover, .i:focus-visible, .i.on { color: #88c0d0; border-color: #3b4252; background: #1c1f26; }
    /* Upward, because it is anchored to the bottom — pinned by its bottom
       edge rather than its top, so a tall page log grows away from the
       button instead of over it. */
    .pop {
      position: fixed; right: 0.6rem; bottom: 2.4rem;
      background: #1c1f26; border: 1px solid #2c313c; border-radius: 8px;
      padding: 0.7rem 0.9rem; width: min(38rem, 92vw); max-height: 60vh; overflow: auto;
      font-size: 0.8rem; line-height: 1.45;
    }
    .pop h3 { margin: 0.6rem 0 0.2rem; font-size: 0.82rem; color: #88c0d0; }
    .pop h3:first-child { margin-top: 0; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, monospace; color: #9aa5b8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.15rem 0.8rem; }
  `;

  #open = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this.#esc);
    document.addEventListener("click", this.#outside, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.#outside, true);
    super.disconnectedCallback();
  }

  #esc = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.#open) return;
    e.stopPropagation();
    this.#shut();
  };

  #outside = (e: Event): void => {
    if (!this.#open || e.composedPath().includes(this)) return;
    this.#shut();
  };

  #shut(): void {
    this.#open = false;
    this.requestUpdate();
  }

  override render(): TemplateResult | typeof nothing {
    // The wizard is a modal <dialog>, so its backdrop would cover this
    // anyway — and a control nobody can reach is one worth not drawing.
    if (phase.get() !== "chat") return nothing;
    return html`
      <button
        class="i ${this.#open ? "on" : ""}"
        title="what this page knows: the agent's state, the transport's numbers, and the page log"
        aria-label="details"
        aria-expanded=${this.#open}
        @click=${() => { this.#open = !this.#open; this.requestUpdate(); }}
      >i</button>
      ${this.#open ? this.#details() : nothing}
    `;
  }

  #details(): TemplateResult {
    const a = agentFacts.get();
    const d = diagnostics.get();
    return html`<div class="pop">
      ${a
        ? html`<h3>where its state lives</h3>
            <pre>${a.state.mode}
${a.state.why}</pre>`
        : nothing}
      ${d
        ? html`<h3>transport</h3>
            <div class="grid">
              <span>messages in: ${d.messagesIn}</span>
              <span>messages out: ${d.messagesOut}</span>
              <span>junk lines: ${d.junkLines}</span>
              <span>refused frames: ${d.refusedIn}</span>
              <span>overflows: ${d.overflows}</span>
            </div>
            ${d.stderr.length ? html`<h3>agent stderr (last lines)</h3><pre>${d.stderr.slice(-12).join("\n")}</pre>` : nothing}`
        : nothing}
      <h3>page log</h3>
      <pre>${logText.get().split("\n").slice(-25).join("\n")}</pre>
    </div>`;
  }
}

customElements.define("acp-details", AcpDetails);
