// Setup: a <dialog> over the empty chat. Two steps — run the helper, pick
// the folder — and then it dissolves. Same shape as the terminal demo's,
// minus the session picker (an agent session is not something you resume;
// #58's story would arrive with a transcript story, not before it).
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { gate, phase, wizardStep, folder, helper, pickError } from "../state";
import { pickFolder, onMac } from "../connection";

const CMD = "npx github:dglazkov/fsio#acp-demo";

class AcpWizard extends SignalWatcher(LitElement) {
  static override styles = css`
    dialog {
      background: #1c1f26; color: #d8dee9; border: 1px solid #2c313c;
      border-radius: 12px; padding: 1.4rem 1.6rem; width: min(36rem, 92vw);
      font: inherit; line-height: 1.5;
    }
    dialog::backdrop { background: rgba(10, 12, 16, 0.55); backdrop-filter: blur(2px); }
    h1 { font-size: 1.15rem; margin: 0; font-weight: 600; }
    h1 .dim { color: #5e81ac; font-weight: 400; }
    .tagline { color: #9aa5b8; margin: 0.2rem 0 1.1rem; font-size: 0.92rem; }
    .crumbs { display: flex; gap: 1rem; font-size: 0.8rem; color: #5c6675; margin-bottom: 0.9rem; }
    .crumbs .on { color: #88c0d0; }
    .explain { color: #9aa5b8; font-size: 0.9rem; margin: 0.2rem 0 0.8rem; }
    button {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 6px; padding: 0.45rem 1rem; font: inherit; cursor: pointer;
    }
    button:hover { background: #3b4252; }
    button.primary { background: #5e81ac; border-color: #5e81ac; color: #eceff4; font-weight: 600; }
    button.primary:hover { background: #6d8fb8; }
    button.small { font-size: 0.8rem; padding: 0.2rem 0.6rem; }
    button.ghost { background: none; border: none; color: #81a1c1; padding: 0.2rem 0.3rem; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cmd {
      display: flex; align-items: center; gap: 0.6rem; background: #14161a;
      border-radius: 6px; padding: 0.5rem 0.8rem; margin: 0.4rem 0 0.6rem;
    }
    .cmd code { font-size: 0.85rem; overflow-x: auto; white-space: nowrap; flex: 1; }
    .fineprint { color: #7b8598; font-size: 0.82rem; margin: 0.5rem 0 0; }
    .status { font-size: 0.9rem; margin-top: 0.7rem; }
    .status.ok::before { content: "✅ "; }
    .status.wait::before { content: "⏳ "; }
    .status.bad::before { content: "❌ "; }
    .status .hint { color: #9aa5b8; font-size: 0.85rem; display: block; margin-top: 0.15rem; }
    .row { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; margin-top: 1rem; }
    .gate strong { color: #ef8a95; }
    .gate .hint { color: #d8b9bc; font-size: 0.9rem; margin-top: 0.4rem; }
  `;

  override render(): TemplateResult {
    const g = gate.get();
    return html`<dialog @cancel=${(e: Event) => e.preventDefault()}>
      ${g ? html`<div class="gate"><strong>${g.msg}</strong><div class="hint">${g.hint}</div></div>` : this.#steps()}
    </dialog>`;
  }

  protected override updated(): void {
    const d = this.renderRoot.querySelector("dialog")!;
    const open = gate.get() !== null || phase.get() === "wizard";
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }

  #header(): TemplateResult {
    return html`<header>
      <h1>fsio <span class="dim">/ agent</span></h1>
      <p class="tagline">
        a coding agent on your machine, driven from this page — its whole
        conversation transported through files in a folder you grant.
      </p>
    </header>`;
  }

  #steps(): TemplateResult {
    const s = wizardStep.get();
    return html`${this.#header()}
      <div class="crumbs">
        <span class=${s === 1 ? "on" : ""}>1 · run the helper</span>
        <span class=${s === 2 ? "on" : ""}>2 · pick the folder</span>
      </div>
      ${s === 1 ? this.#stepRun() : this.#stepPick()}`;
  }

  #stepRun(): TemplateResult {
    return html`
      <p class="explain">
        In a terminal, <code>cd</code> into the project you want the agent to
        work on, then:
      </p>
      <div class="cmd">
        <code>${CMD}</code>
        <button class="small" @click=${() => void navigator.clipboard.writeText(CMD)}>copy</button>
      </div>
      <p class="fineprint">
        You'll need an ACP agent installed — e.g. <code>npm i -g pi-acp</code>.
        The helper starts it for you and won't start anything else: the page
        can name an agent from the helper's list, never a path.
      </p>
      <p class="fineprint">
        ${onMac
          ? html`macOS only (for now). The agent is sandboxed to that folder —
              it reads the world and talks to the network (its brain is
              remote), but writes anywhere outside the folder are denied. The
              policy is a plain text file in
              <code>.fsio/profiles/</code>, and this page will show it to you.`
          : html`<strong>Heads up: the helper is macOS-only for now</strong>
              (its sandbox is Apple's Seatbelt). The page connects from
              anywhere; the helper side needs a Mac.`}
      </p>
      <div class="row">
        <button class="primary" @click=${() => wizardStep.set(2)}>I've run it — next</button>
      </div>
    `;
  }

  #stepPick(): TemplateResult {
    const err = pickError.get();
    const f = folder.get();
    const h = helper.get();
    return html`
      <p class="explain">
        Pick the <em>same folder</em> the helper is running in. Chrome asks
        twice — once to view, once to save. That gesture is the whole
        security model: you are granting this page one folder, and the agent
        gets exactly the same one.
      </p>
      <div class="row">
        <button class="ghost small" @click=${() => wizardStep.set(1)}>← back</button>
        <button class="primary" @click=${() => void pickFolder()}>Choose folder…</button>
        ${f ? html`<span class="fineprint">${f.name}/</span>` : nothing}
      </div>
      ${err ? html`<div class="status bad">${err.msg}<span class="hint">${err.hint}</span></div>` : nothing}
      ${!err && f && h === "silent"
        ? html`<div class="status wait">
            folder connected, but no helper heartbeat
            <span class="hint">The helper writes a heartbeat every 2 seconds and we're not seeing it. Is it still running, in this exact folder?</span>
          </div>`
        : nothing}
      ${!err && f && h === "alive" ? html`<div class="status ok">helper found — starting the agent</div>` : nothing}
    `;
  }
}

customElements.define("acp-wizard", AcpWizard);
