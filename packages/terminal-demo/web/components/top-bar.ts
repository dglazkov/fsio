// The bar: which folder this page is holding, the shells in it, and whether
// the helper is answering.
//
// It used to be a wordmark and the tabs, with the folder named along the
// bottom in a status bar. That put the one fact the whole demo is about — the
// folder you granted — furthest from the thing it explains, and spent the
// most-read row of the page on a logo. So the bar says the folder and the
// strip says what is open in it: the same statement, read left to right. The
// status bar's other contents went to the corner "i" (components/details.ts),
// and its "detach" button went onto the chip, beside the "×" it is the
// alternative to.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens } from "@fsio/ui";
import { folder, helper, phase } from "../state";
import "./tab-bar";

class FsioTopBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    css`
      :host {
        display: flex; align-items: center; gap: 0.7rem;
        padding: 0.35rem 0.9rem; background: var(--fsio-panel);
        -webkit-backdrop-filter: var(--fsio-glass-blur);
        backdrop-filter: var(--fsio-glass-blur);
        border-bottom: 1px solid var(--fsio-line); font-size: 0.85rem;
        position: relative; z-index: 3;
      }
      .name {
        font-family: var(--fsio-title); font-weight: 400; font-size: 1.15rem;
        color: var(--fsio-fg-bright); flex: none; line-height: 1.2;
      }
      /* The strip takes the middle and does its own pushing: its internal
         spacer is what keeps "+" beside the last chip instead of at the far
         right, so this row needs no spacer of its own. */
      fsio-tab-bar { flex: 1; min-width: 0; }
      .quiet { color: var(--fsio-warn-quiet); cursor: help; flex: none; }
    `,
  ];

  override render(): TemplateResult {
    const f = folder.get();
    const connected = phase.get() === "shell" || phase.get() === "picker";
    return html`
      <span class="name">${f ? `${f.name}/` : "fsio terminal"}</span>
      <fsio-tab-bar></fsio-tab-bar>
      <!-- Only the silence is worth saying. A helper that is answering is the
           normal case, and a green light confirming it every second is a light
           nobody reads — whereas a helper that has stopped is why the page
           feels stuck, and it belongs beside the folder because it is a fact
           about the folder. -->
      ${connected && helper.get() === "silent"
        ? html`<span class="quiet" title="The helper writes a heartbeat into this folder every 2 seconds and we are not seeing it. Is it still running, in this exact folder?">no helper heartbeat</span>`
        : nothing}
    `;
  }
}

customElements.define("fsio-top-bar", FsioTopBar);
