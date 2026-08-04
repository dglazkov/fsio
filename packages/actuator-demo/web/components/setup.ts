// Setup: a modal over the app, saying the two things that have to be true
// before a terminal can reach this page — the helper is running in a folder,
// and you granted this page that same folder.
//
// The frame is @fsio/ui's (all three pages open the same way); the panels
// are this page's, because what a folder *means* differs per demo. Here it
// means: the place your commands will come from.
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { wizardStyles } from "@fsio/ui";
import { gate, helper, phase, pickError, reconnectTo } from "../state";
import { pickFolder, regrant } from "../session";

// Not an npx one-liner like the other two demos: this one has no bundled
// branch yet (CI packages terminal-demo and acp-demo only), and a command
// that does not exist is worse than a longer one that does.
const CMD = "npm run actuator-helper -- ~/your-folder";

const TAGLINE =
  "a page that owns its state, driven from a terminal on your machine — " +
  "through nothing but files in a folder.";

class ActuatorSetup extends SignalWatcher(LitElement) {
  static override styles = wizardStyles;

  override render(): TemplateResult {
    const g = gate.get();
    const p = phase.get();
    return html`<fsio-wizard-frame
      edition="actuator"
      .tagline=${g ? "" : TAGLINE}
      ?open=${g !== null || (p !== "live" && p !== "boot")}
    >
      ${g
        ? html`<div class="gate"><strong>${g.msg}</strong><div class="hint">${g.hint}</div></div>`
        : p === "reconnect"
          ? this.#reconnect()
          : this.#pick()}
    </fsio-wizard-frame>`;
  }

  #pick(): TemplateResult {
    const err = pickError.get();
    return html`
      <p class="explain">
        In a terminal, from the fsio repo, start the helper on a folder you're
        comfortable handing to this page:
      </p>
      <fsio-cmd command=${CMD}></fsio-cmd>
      <p class="explain">
        Then pick that <em>same folder</em> here. Chrome will ask twice — once
        to view, once to save. That double gesture is the security model: you
        are handing this page one folder, and the folder is the only way the
        two sides can reach each other.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void pickFolder()}>Choose folder…</button>
        ${helper.get() === "silent"
          ? html`<span class="fineprint">folder connected — waiting for the helper's heartbeat</span>`
          : nothing}
      </div>
      ${err ? html`<div class="status bad">${err}</div>` : nothing}
      <p class="fineprint">
        Everything the page holds stays in the browser. The folder carries
        commands one way and receipts the other, and nothing else.
      </p>
    `;
  }

  /** The remembered folder, one click from usable again — `requestPermission`
   *  needs a user activation (F15), so the page cannot do this by itself. */
  #reconnect(): TemplateResult {
    const name = reconnectTo.get()?.name ?? "your folder";
    return html`
      <p class="explain">
        You granted <strong>${name}/</strong> before. Chrome needs one click to
        hand it back.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void regrant()}>Reconnect to ${name}/</button>
        <button class="ghost small" @click=${() => void pickFolder()}>Pick a different folder…</button>
      </div>
    `;
  }
}

customElements.define("actuator-setup", ActuatorSetup);
