// What this page knows about itself: what you are actually looking at, what
// the active shell is doing, and the page's own log.
//
// This was a status bar along the bottom of the page, and everything in it
// was one of two things: a fact already said better somewhere else (the
// folder, now in the top bar; the heartbeat, now beside it), or material you
// want when the page is behaving oddly and never otherwise. The second kind
// is what an "i" in the corner is for, and moving it there gave the terminal
// back the bottom of the viewport. The corner and the popover are
// `@fsio/ui`'s; the words are this page's.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { diagBody, tokens } from "@fsio/ui";
import { activeTab, phase } from "../state";
import { logText } from "../reporter";

class FsioDetailsPanel extends SignalWatcher(LitElement) {
  static override styles = [tokens, diagBody, css`:host { display: contents; }`];

  override render(): TemplateResult | typeof nothing {
    // The wizard is a modal <dialog>, so its backdrop would cover this
    // anyway — and a control nobody can reach is one worth not drawing.
    if (phase.get() !== "shell") return nothing;
    const t = activeTab.get();
    return html`<fsio-details
      label="what this page knows: what you're looking at, what this shell is doing, and the page log"
    >
      <h3>what am I looking at?</h3>
      <p>
        A real shell on your machine — but this page has no server behind it.
        No websocket, no cloud, not even a localhost port. The only connection
        between this tab and the shell is <em>the folder you picked</em>: every
        keystroke is written to a file, a tiny helper reads it and feeds the
        shell, the shell's output is written to another file, and the page
        reads it back. The filesystem is the entire transport — fast enough
        that you didn't notice.
      </p>
      <p>
        Because the sessions themselves live in files, shells outlive the
        page: leave one running and it keeps going with no tab attached; come
        back later and resume it, scrollback and all. Another window can even
        take a running shell over while you watch.
      </p>
      <p>
        And the folder is the whole deal in the other direction too: the shell
        is sandboxed to it. It can read the world, but writes anywhere else
        are denied — the policy is a plain text file at
        <code>.fsio/sandbox.sb</code>. (If your shell grumbled once about its
        history file, that was the sandbox saying no.)
      </p>
      ${t ? html`<h3>this shell</h3><pre>${t.detail.get()}</pre>` : nothing}
      <h3>appearance</h3>
      <fsio-theme-switch></fsio-theme-switch>
      <h3>page log</h3>
      <button class="small" @click=${() => void navigator.clipboard.writeText(logText.get())}>copy log</button>
      <pre class="log">${logText.get()}</pre>
      <div class="foot">
        an <a href="https://github.com/dglazkov/fsio">fsio</a> demo · the
        measurement workbench lives in the repo (<code>scripts/dev.sh</code>)
      </div>
    </fsio-details>`;
  }

  /** The log is read newest-first in practice, so it opens at the bottom. */
  protected override updated(): void {
    const pre = this.renderRoot.querySelector("pre.log");
    if (pre) pre.scrollTop = pre.scrollHeight;
  }
}

customElements.define("fsio-details-panel", FsioDetailsPanel);
