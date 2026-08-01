// Setup: a <dialog> over the empty chat. Two steps — run the helper, pick
// the folder — and then it dissolves. Same shape as the terminal demo's,
// minus the session picker (an agent session is not something you resume;
// #58's story would arrive with a transcript story, not before it).
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { agents, gate, phase, wizardStep, folder, helper, pickError, type AgentOffer } from "../state";
import { chooseAgent, pickFolder, onMac } from "../connection";

// The one-liner (#106): CI force-pushes the bundled helper to the `acp-demo`
// branch on every green main, so this installs and runs the same code the
// repo just tested. No clone, no build, no second terminal to get one.
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
    .agent {
      border: 1px solid #2c313c; border-radius: 8px; padding: 0.6rem 0.8rem;
      margin: 0.5rem 0; display: flex; gap: 0.8rem; align-items: center;
    }
    .agent .who { flex: 1; min-width: 0; }
    .agent .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
    .agent .what { color: #9aa5b8; font-size: 0.85rem; margin-top: 0.1rem; }
    .agent .asks { color: #a3be8c; }
    .agent .hands { color: #d9b477; }
    .agent .cmd { margin: 0.35rem 0 0; }
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
        <span class=${s === 3 ? "on" : ""}>3 · the agent</span>
      </div>
      ${s === 1 ? this.#stepRun() : s === 2 ? this.#stepPick() : this.#stepAgent()}`;
  }

  #stepRun(): TemplateResult {
    return html`
      <p class="explain">
        In a terminal, <code>cd</code> into the project you want the agent to
        work on, then run:
      </p>
      <div class="cmd">
        <code>${CMD}</code>
        <button class="small" @click=${() => void navigator.clipboard.writeText(CMD)}>copy</button>
      </div>
      <p class="fineprint">
        No ACP agent installed? Run it anyway — the helper starts without one,
        and step 3 shows you what this machine has and how to get one. It will
        not start anything that isn't on its own list: this page names an
        agent, never a path.
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

  /** Step 3 (#102): what this machine has, and what each one will do.
   *
   *  Reached only when there is something to say — several agents to pick
   *  between, or none at all. With exactly one installed the page names it
   *  and never shows this. */
  #stepAgent(): TemplateResult {
    const roster = agents.get() ?? [];
    const ready = roster.filter((a) => a.installed);
    const rest = roster.filter((a) => !a.installed);
    return html`
      ${ready.length
        ? html`<p class="explain">
            This machine has ${ready.length} ACP agents. Pick the one to drive —
            the page sends its <em>name</em>, and the helper looks that up in
            its own allow-list.
          </p>`
        : html`<p class="explain">
            No ACP agent on this machine yet. The helper is running and this
            page is watching: install one in a terminal and it shows up here,
            no restart, no reload.
          </p>`}
      ${ready.map((a) => this.#agent(a))}
      ${rest.length
        ? html`<p class="fineprint">${ready.length ? "Also known here, not installed:" : "The helper knows these:"}</p>
            ${rest.map((a) => this.#agent(a))}`
        : nothing}
      <p class="fineprint">
        fsio ships no agent on purpose: vendoring one costs ~118 MB of
        dependencies, and an agent you installed is one you can also inspect,
        update and revoke. Only want to see the permission card? Re-run the
        helper with <code>--fixture</code> — that's a scripted puppet, not a
        real agent, and it says so.
      </p>
    `;
  }

  /** One roster line. The `asks` sentence is the one that matters: this
   *  demo is about the agent's consent question becoming page UI, and not
   *  every agent sends one (F29/F30). Saying so before the choice beats
   *  discovering it after a turn that edited a file silently. */
  #agent(a: AgentOffer): TemplateResult {
    return html`<div class="agent">
      <div class="who">
        <span class="name">${a.name}</span> — ${a.title}
        <div class="what">
          ${a.asks
            ? html`<span class="asks">asks before it edits</span> — the permission card is this demo`
            : html`<span class="hands">edits with its own hands</span> — you'll see the transport and the live
                workspace, but no permission card`}
        </div>
        ${a.installed
          ? nothing
          : html`<div class="cmd">
              <code>${a.install}</code>
              <button class="small" @click=${() => void navigator.clipboard.writeText(a.install)}>copy</button>
            </div>`}
      </div>
      ${a.installed
        ? html`<button class="primary" @click=${() => void chooseAgent(a.name)}>Use this one</button>`
        : nothing}
    </div>`;
  }
}

customElements.define("acp-wizard", AcpWizard);
