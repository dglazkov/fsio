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
import { adopted, agentFacts, diagnostics, folder, helper, past, resumed, turn, viewing, type PastConversation } from "../state";
import { logText } from "../reporter";
import { currentRoot, endSession, startNewSession } from "../connection";
import { closePast, openPast } from "../history";
import { isTail } from "../../src/transcripts.js";

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
    button.danger { color: #ef8a95; border-color: #6b3b40; }
    button.danger:hover { color: #ffd7db; background: #3b2226; }
    .resumed { color: #a3be8c; cursor: help; }
    /* Not green: "joined" is a weaker claim than "resumed" — the agent's
       half came back whole and the human's half did not exist to come back. */
    .joined { color: #d9b477; cursor: help; }
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
    .pop .explain { color: #7b8598; margin: 0 0 0.6rem; }
    .pop .row {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.35rem 0; border-top: 1px solid #22262e;
    }
    .pop .row .who { flex: 1; min-width: 0; display: flex; gap: 0.5rem; }
    .pop .row .name { color: #d8dee9; font-weight: 500; }
    button.pick { color: #88c0d0; border-color: #3b4252; }
  `;

  #open = false;
  #pastOpen = false;
  /** The end button arms on first click and fires on second — a sticky
   *  session's one irreversible gesture should cost two. */
  #armed = false;

  override render(): TemplateResult {
    const f = folder.get();
    const a = agentFacts.get();
    const t = turn.get();
    const v = viewing.get();
    if (v) return this.#reading(v);
    return html`
      <span class="name">${a ? a.agent : "fsio agent"}</span>
      ${f ? html`<span class="dim">in ${f.name}/</span>` : nothing}
      ${a
        ? html`<span class="badge ${a.sandboxed ? "" : "open"}" title=${a.confinement}>
            ${a.sandboxed ? "sandboxed" : "NOT sandboxed"}
          </span>`
        : nothing}
      ${adopted.get()
        ? html`<span class="joined" title="This page joined a conversation that was already in progress and had no record of it (#117). Everything above the note in the transcript is the agent's half only — what was typed into it lived in a browser record this one does not have.">joined in progress</span>`
        : resumed.get()
          ? html`<span class="resumed" title="This page reattached to a session that was already running — the agent kept going while the tab was gone (D32).">resumed</span>`
          : nothing}
      <span class="spacer"></span>
      <span class="turn">
        ${t === "thinking" ? "thinking…" : t === "cancelling" ? "cancelling…" : t === "starting" ? "starting…" : t === "gone" ? "agent gone" : helper.get() === "silent" ? "helper silent" : ""}
      </span>
      ${this.#lifetime(a, t)}
      ${this.#pastButton()}
      <button @click=${() => { this.#open = !this.#open; this.requestUpdate(); }}>details</button>
      ${this.#open ? this.#details() : nothing}
      ${this.#pastOpen ? this.#pastList() : nothing}
    `;
  }

  /** Reading an ended conversation (#119): the bar becomes the document's
   *  masthead. Nothing about the live session belongs here — there may not
   *  be one, and the badges that describe an agent would be describing one
   *  that exited. */
  #reading(v: PastConversation): TemplateResult {
    return html`
      <span class="name">${v.agent || "a past conversation"}</span>
      <span class="dim">${v.ended ? new Date(v.ended).toLocaleString() : "ended"}${v.why ? ` · ${v.why}` : ""}</span>
      <span class="badge">read-only</span>
      <span class="spacer"></span>
      <span class="dim">the agent's half — what you typed rode the uplink, which the folder does not keep</span>
      <button @click=${() => closePast()}>close</button>
    `;
  }

  /** Only when there is something to offer. A button that opens an empty
   *  list is a question the page could have answered itself. */
  #pastButton(): TemplateResult | typeof nothing {
    const n = past.get().length;
    if (!n) return nothing;
    return html`<button
      title="Conversations that ended in this folder. The helper keeps them; Ctrl-C no longer takes them (D26 rule 4)."
      @click=${() => { this.#pastOpen = !this.#pastOpen; this.#open = false; this.requestUpdate(); }}
    >past · ${n}</button>`;
  }

  #pastList(): TemplateResult {
    const root = currentRoot();
    return html`<div class="pop">
      <h3>past conversations in this folder</h3>
      <p class="explain">
        Kept as the helper swept each session (D26 rule 4). Read-only, and
        the agent's half only: your prompts rode the uplink, which is not
        what the folder keeps.
      </p>
      ${past.get().map(
        (p) => html`<div class="row">
          <button
            class="pick"
            ?disabled=${!root}
            @click=${() => { this.#pastOpen = false; this.requestUpdate(); if (root) void openPast(root, p); }}
          >read</button>
          <span class="who">
            <span class="name">${p.agent || p.kind || "session"}</span>
            <span class="dim">${p.ended ? new Date(p.ended).toLocaleString() : p.id}</span>
          </span>
          <span class="dim">${sizeOf(p.bytes)}${isTail(p) ? " · tail only" : ""}</span>
        </div>`
      )}
    </div>`;
  }

  /** The other half of sticky sessions (#113): closing the tab no longer
   *  kills the agent, so the page owes the human a control that does — and
   *  it has to say what it costs, because nothing else here is irreversible. */
  #lifetime(a: ReturnType<typeof agentFacts.get>, t: ReturnType<typeof turn.get>): TemplateResult | typeof nothing {
    if (t === "gone") {
      return html`<button @click=${() => void startNewSession()}>new session</button>`;
    }
    if (!a) return nothing;
    if (!this.#armed) {
      return html`<button
        title="Ends this conversation and stops the agent. Closing the tab does not — the session waits for you."
        @click=${() => { this.#armed = true; this.requestUpdate(); }}
      >
        end session
      </button>`;
    }
    return html`<button class="danger" @click=${() => { this.#armed = false; void endSession(); }}>
      end it — this stops ${a.agent}
    </button>
    <button @click=${() => { this.#armed = false; this.requestUpdate(); }}>cancel</button>`;
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

const sizeOf = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

customElements.define("acp-top-bar", AcpTopBar);
