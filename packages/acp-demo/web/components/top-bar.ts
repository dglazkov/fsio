// The bar: which folder this page is holding, the conversations in it, and
// how this page got here.
//
// Everything it renders itself is the folder's (#140); the conversations are
// the strip's, which is a child rather than a copy. It used to render the
// conversation's own facts too — the agent's name, an "end conversation" that was
// the chip's "×" under another label, and a "past conversations" list that
// was the tab bar's "+" list in its other state. With one conversation that
// read as a header. With N it read as ambiguity about which layer owned
// what, so all three moved down to the chip, which is the thing that IS a
// conversation, and "details" moved to the corner because a debugging
// affordance does not belong at the same weight as the facts about what you
// are working on.
//
// What is left is the folder and the strip of conversations in it, on one
// row. Two rows was one row too many once the top one had stopped describing
// a conversation: "fsio-demo/" and the chips are the same statement said
// left to right — this folder, and what is open in it. A count beside them
// ("3 conversations here") was the version of that sentence from before the
// chips could be seen, and it went with the second row.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens } from "@fsio/ui";
import { adopted, folder, helper, resumed } from "../state";
import "./tab-bar";

class AcpTopBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    css`
      :host {
        display: flex; align-items: center; gap: 0.7rem;
        padding: 0.35rem 0.9rem; background: var(--fsio-bg);
        border-bottom: 1px solid var(--fsio-line); font-size: 0.85rem;
      }
      .name { font-weight: 600; color: var(--fsio-fg-bright); flex: none; }
      /* The strip takes the middle and does its own pushing: its internal
         spacer is what keeps "+" beside the last chip instead of at the far
         right, so this row needs no spacer of its own. */
      acp-tab-bar { flex: 1; min-width: 0; }
      .dim { color: var(--fsio-dimmer); }
      .quiet { color: var(--fsio-warn-quiet); cursor: help; flex: none; }
      .resumed { color: var(--fsio-good); cursor: help; }
      /* Not green: "joined" is a weaker claim than "resumed" — the agent's
         half came back whole and the human's half did not exist to come back. */
      .joined { color: var(--fsio-warn-quiet); cursor: help; }
    `,
  ];

  override render(): TemplateResult {
    const f = folder.get();
    return html`
      <span class="name">${f ? `${f.name}/` : "fsio agent"}</span>
      <acp-tab-bar></acp-tab-bar>
      ${adopted.get()
        ? html`<span class="joined" title="This page joined a conversation that was already in progress and had no record of it (#117). Everything above the note in the transcript is the agent's half only — what was typed into it lived in a browser record this one does not have.">joined in progress</span>`
        : resumed.get()
          ? html`<span class="resumed" title="This page reattached to a session that was already running — the agent kept going while the tab was gone.">resumed</span>`
          : nothing}
      <!-- The helper is the folder's, so it says so here — and only its
           silence is worth saying, in the same words the terminal demo uses.
           A helper that is answering is the normal case, and a light
           confirming it every second is a light nobody reads; a helper that
           has stopped is why the page feels stuck.

           The turn is the conversation's and moved into the log with the rest
           of the conversation layer: "thinking…" is the newest thing in a
           transcript, not a property of the page, and up here it was being
           said about whichever conversation happened to be on screen.
           "agent gone" went with it — the chip's dot and the composer both
           already say it, in the places you are looking when it matters. -->
      ${helper.get() === "silent"
        ? html`<span class="quiet" title="The helper writes a heartbeat into this folder every 2 seconds and we are not seeing it. Is it still running, in this exact folder?">no helper heartbeat</span>`
        : nothing}
    `;
  }
}

customElements.define("acp-top-bar", AcpTopBar);
