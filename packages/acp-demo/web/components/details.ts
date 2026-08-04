// What this page knows about itself: what a person is looking at, where the
// agent's state lives, and what the transport has moved.
//
// It was a "details" button in the top bar, sitting in the row that names the
// folder and says whether the helper is alive (#140). That put a debugging
// affordance at the same weight as the facts about what you are working on,
// in the one strip that has to stay readable at a glance. Nothing here is
// needed to use the page — it is needed when the page is behaving oddly — so
// it is an "i" in the corner, out of the way until it is wanted. The corner
// and the popover are `@fsio/ui`'s; the contents are this page's.
//
// Two changes when the three "i"s were homogenized. The theme switch and the
// page log left for the popover itself — they were the same two sections on
// all three pages, and the log here was the one that had been silently
// truncated to its last 25 lines, which is a log that cannot answer the
// question you opened it for. And "what am I looking at" arrived: the terminal
// demo had one and it is the best thing in that popover, because the claim
// this page is making is genuinely not visible from the page.
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
      label="what this page knows: what you're looking at, the agent's state, the transport's numbers, and the page log"
      .log=${logText.get()}
    >
      <h3>what am I looking at?</h3>
      <p>
        A coding agent running on your machine, driven from this page — and
        there is no server between the two. No websocket, no cloud, not even a
        localhost port. Every message you send and everything the agent says
        back is written into <em>the folder you granted</em>, a helper process
        reads it out and feeds the agent, and the answers come back the same
        way. The permission cards are the agent's own questions, rendered here
        instead of in a terminal.
      </p>
      <p>
        The pane on the right is the same grant used a second time: the page
        reads those files directly, so you watch the folder change while the
        agent talks about changing it. And the agent outlives the tab — close
        this page and it keeps working; the “+” list is how you find it again.
      </p>
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
      <div slot="foot" class="foot">
        an <a href="https://github.com/dglazkov/fsio">fsio</a> demo · the
        measurement workbench lives in the repo (<code>scripts/dev.sh</code>)
      </div>
    </fsio-details>`;
  }
}

customElements.define("acp-details", AcpDetails);
