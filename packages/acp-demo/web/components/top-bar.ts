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
//
// The row itself is `@fsio/ui`'s now: all three pages had written the same
// flex-and-glass header, one of them twice, down to this file's comment about
// the strip's spacer. What is left is this page's half — which signals to
// read, and the two conditions worth a word on the right.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens } from "@fsio/ui";
import { adopted, files, folder, helper, resumed, workspaceOpen } from "../state";
import "./tab-bar";

class AcpTopBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    // `display: contents` so the shared bar is the page's actual header box
    // rather than a second surface nested inside this one.
    css`
      :host { display: contents; }
      .quiet { color: var(--fsio-warn-quiet); cursor: help; }
      .resumed { color: var(--fsio-good); cursor: help; }
      /* Opens the workspace when the workspace has nowhere to sit. Hidden at
         widths where the pane is simply there, on the breakpoint index.html
         and the pane both use. */
      .drawerBtn {
        display: none; align-items: center; gap: 0.3rem;
        background: none; border: 1px solid var(--fsio-line-strong); border-radius: 6px;
        color: var(--fsio-dimmer); font: inherit; font-size: 0.74rem;
        padding: 0.15rem 0.5rem; cursor: pointer;
      }
      .drawerBtn:hover { color: var(--fsio-fg-bright); border-color: var(--fsio-control-hover); }
      .drawerBtn:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 2px; }
      @media (max-width: 800px) { .drawerBtn { display: inline-flex; } }
      /* Not green: "joined" is a weaker claim than "resumed" — the agent's
         half came back whole and the human's half did not exist to come back. */
      .joined { color: var(--fsio-warn-quiet); cursor: help; }
    `,
  ];

  override render(): TemplateResult {
    const f = folder.get();
    return html`
      <fsio-top-bar name=${f ? `${f.name}/` : "fsio agent"}>
        <acp-tab-bar></acp-tab-bar>
        ${f
          ? html`<button
              slot="status"
              class="drawerBtn"
              aria-expanded=${workspaceOpen.get()}
              title="the files in this folder, as the page sees them"
              @click=${() => workspaceOpen.set(!workspaceOpen.get())}
            >
              files${files.get().length ? html` · ${files.get().length}` : nothing}
            </button>`
          : nothing}
        ${adopted.get()
          ? html`<span slot="status" class="joined" role="status" title="This page joined a conversation that was already in progress and had no record of it (#117). Everything above the note in the transcript is the agent's half only — what was typed into it lived in a browser record this one does not have.">joined in progress</span>`
          : resumed.get()
            ? html`<span slot="status" class="resumed" role="status" title="This page reattached to a session that was already running — the agent kept going while the tab was gone.">resumed</span>`
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
          ? html`<span slot="status" class="quiet" role="status" title="The helper writes a heartbeat into this folder every 2 seconds and we are not seeing it. Is it still running, in this exact folder?">no helper heartbeat</span>`
          : nothing}
      </fsio-top-bar>
    `;
  }
}

customElements.define("acp-top-bar", AcpTopBar);
