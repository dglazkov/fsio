// The bar: who is running, in which folder, behind which wall — and a
// popover with the transport's own numbers.
//
// The confinement badge is not decoration. D30 rule 5 makes confinement a
// *session fact the page reads* (`sandboxed`, `confinement`), so an
// unconfined agent says so here, in the same place a confined one does.
// R3's rule with a UI: a demo whose safety sentence is hardcoded in the
// page would keep saying it after the safety went away.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { agentFacts, diagnostics, folder, helper, turn } from "../state";
import { logText } from "../reporter";

class AcpTopBar extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex; align-items: center; gap: 0.8rem;
      padding: 0.45rem 0.9rem; background: #191c22;
      border-bottom: 1px solid #262b34; font-size: 0.85rem;
    }
    .name { font-weight: 600; color: #eceff4; }
    .dim { color: #7b8598; }
    .spacer { flex: 1; }
    .badge {
      border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.78rem;
      border: 1px solid #3b4252; color: #a3be8c; cursor: help;
    }
    .badge.open { color: #ebcb8b; border-color: #6b5a2e; }
    .turn { color: #88c0d0; }
    button {
      background: none; border: 1px solid #3b4252; border-radius: 6px;
      color: #9aa5b8; font: inherit; font-size: 0.8rem; padding: 0.1rem 0.5rem; cursor: pointer;
    }
    button:hover { color: #d8dee9; }
    .pop {
      position: fixed; right: 0.8rem; top: 2.6rem; z-index: 20;
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

  override render(): TemplateResult {
    const f = folder.get();
    const a = agentFacts.get();
    const t = turn.get();
    return html`
      <span class="name">${a ? a.agent : "fsio agent"}</span>
      ${f ? html`<span class="dim">in ${f.name}/</span>` : nothing}
      ${a
        ? html`<span class="badge ${a.sandboxed ? "" : "open"}" title=${a.confinement}>
            ${a.sandboxed ? "sandboxed" : "NOT sandboxed"}
          </span>`
        : nothing}
      <span class="spacer"></span>
      <span class="turn">
        ${t === "thinking" ? "thinking…" : t === "cancelling" ? "cancelling…" : t === "starting" ? "starting…" : t === "gone" ? "agent gone" : helper.get() === "silent" ? "helper silent" : ""}
      </span>
      <button @click=${() => { this.#open = !this.#open; this.requestUpdate(); }}>details</button>
      ${this.#open ? this.#details() : nothing}
    `;
  }

  #details(): TemplateResult {
    const a = agentFacts.get();
    const d = diagnostics.get();
    return html`<div class="pop">
      ${a
        ? html`<h3>what confines it</h3>
            <pre>${a.confinement}</pre>
            ${a.profile ? html`<pre class="dim">policy: ${a.profile} — that file is in the folder you granted; open it and read the whole thing.</pre>` : nothing}
            <h3>where its state lives</h3>
            <pre>${a.state.mode}${a.state.dirs.length ? `: ${a.state.dirs.join(", ")}` : ""}
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

customElements.define("acp-top-bar", AcpTopBar);
