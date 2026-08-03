// What this page knows about itself: where the agent's state lives, what the
// transport has moved, and the page's own log.
//
// It was a "details" button in the top bar, sitting in the row that names the
// folder and says whether the helper is alive (#140). That put a debugging
// affordance at the same weight as the facts about what you are working on,
// in the one strip that has to stay readable at a glance. Nothing here is
// needed to use the page — it is needed when the page is behaving oddly — so
// it is an "i" in the corner, out of the way until it is wanted. The corner
// and the popover are `@fsio/ui`'s; the contents are this page's.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { diagBody, tokens } from "@fsio/ui";
import { agentFacts, diagnostics, phase } from "../state";
import { logText } from "../reporter";

class AcpDetails extends SignalWatcher(LitElement) {
  static override styles = [tokens, diagBody, css`:host { display: contents; }`];

  override render(): TemplateResult | typeof nothing {
    // The wizard is a modal <dialog>, so its backdrop would cover this
    // anyway — and a control nobody can reach is one worth not drawing.
    if (phase.get() !== "chat") return nothing;
    const a = agentFacts.get();
    const d = diagnostics.get();
    return html`<fsio-details
      label="what this page knows: the agent's state, the transport's numbers, and the page log"
    >
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
      <h3>appearance</h3>
      <fsio-theme-switch></fsio-theme-switch>
      <h3>page log</h3>
      <pre>${logText.get().split("\n").slice(-25).join("\n")}</pre>
    </fsio-details>`;
  }
}

customElements.define("acp-details", AcpDetails);
