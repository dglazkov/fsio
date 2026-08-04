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
//
// The row itself is `@fsio/ui`'s now — all three pages had written the same
// flex-and-glass header, one of them twice, down to the same comment about the
// strip's spacer. What is left here is the page's half: which signals to read,
// and the one condition this page thinks is worth a word on the right. The
// element is `term-top-bar` because `fsio-top-bar` is the shared one it wraps.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens } from "@fsio/ui";
import { folder, helper, phase } from "../state";
import "./tab-bar";

class TermTopBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    // Nothing of its own but the one word on the right: `display: contents`
    // lets the shared bar be the page's actual header box rather than a
    // second surface nested inside this one.
    css`
      :host { display: contents; }
      .quiet { color: var(--fsio-warn-quiet); cursor: help; }
    `,
  ];

  override render(): TemplateResult {
    const f = folder.get();
    const connected = phase.get() === "shell" || phase.get() === "picker";
    return html`
      <fsio-top-bar name=${f ? `${f.name}/` : "fsio terminal"}>
        <fsio-tab-bar></fsio-tab-bar>
        <!-- Only the silence is worth saying. A helper that is answering is
             the normal case, and a green light confirming it every second is a
             light nobody reads — whereas a helper that has stopped is why the
             page feels stuck, and it belongs beside the folder because it is a
             fact about the folder.

             role="status" so a screen reader hears it arrive. The entire point
             of this word is that it appears while you are looking somewhere
             else, wondering why nothing is happening. -->
        ${connected && helper.get() === "silent"
          ? html`<span
              slot="status"
              class="quiet"
              role="status"
              title="The helper writes a heartbeat into this folder every 2 seconds and we are not seeing it. Is it still running, in this exact folder?"
              >no helper heartbeat</span
            >`
          : nothing}
      </fsio-top-bar>
    `;
  }
}

customElements.define("term-top-bar", TermTopBar);
