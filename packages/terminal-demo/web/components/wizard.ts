// The setup wizard (#34): a <dialog> floating over the empty terminal. The
// current three-step list, recast — step 1 the npx one-liner (+ gates),
// step 2 pick-folder (+ wrong-folder recovery inline), then the dialog
// dissolves (or the #58 session picker intercepts first).
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { gate, phase, wizardStep, folder, helper, pickError, reconnectTo, resumable, tabs } from "../state";
import { pickFolder, regrant, dismissPicker, onMac } from "../connection";
import { openTab } from "../tabs";

const CMD = "npx github:dglazkov/fsio#terminal-demo";

class FsioWizard extends SignalWatcher(LitElement) {
  static override styles = css`
    dialog {
      background: #1c1f26; color: #d8dee9; border: 1px solid #2c313c;
      border-radius: 12px; padding: 1.4rem 1.6rem; width: min(34rem, 92vw);
      font: inherit; line-height: 1.5;
    }
    dialog::backdrop { background: rgba(10, 12, 16, 0.55); backdrop-filter: blur(2px); }
    h1 { font-size: 1.15rem; margin: 0; font-weight: 600; }
    h1 .dim { color: #5e81ac; font-weight: 400; }
    h2 { font-size: 1rem; margin: 0 0 0.3rem; }
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
    button.ghost:hover { background: none; text-decoration: underline; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cmd {
      display: flex; align-items: center; gap: 0.6rem; background: #14161a;
      border-radius: 6px; padding: 0.5rem 0.8rem; margin: 0.4rem 0 0.6rem;
    }
    .cmd code { font-size: 0.85rem; overflow-x: auto; white-space: nowrap; flex: 1; }
    .fineprint { color: #7b8598; font-size: 0.82rem; margin: 0.5rem 0 0; }
    .fineprint code { font-size: 0.78rem; }
    .status { font-size: 0.9rem; margin-top: 0.7rem; }
    .status.ok::before { content: "✅ "; }
    .status.wait::before { content: "⏳ "; }
    .status.bad::before { content: "❌ "; }
    .status .hint { color: #9aa5b8; font-size: 0.85rem; display: block; margin-top: 0.15rem; }
    .row { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; margin-top: 1rem; }
    .sess {
      display: flex; align-items: center; gap: 0.7rem; background: #14161a;
      border-radius: 6px; padding: 0.5rem 0.8rem; margin: 0.4rem 0;
    }
    .sess-info { flex: 1; min-width: 0; }
    .sess-info code { font-size: 0.85rem; }
    .sess-info .hint { color: #9aa5b8; font-size: 0.82rem; display: block; margin-top: 0.1rem; }
    .gate strong { color: #ef8a95; }
    .gate .hint { color: #d8b9bc; font-size: 0.9rem; margin-top: 0.4rem; }
  `;

  override render(): TemplateResult {
    const g = gate.get();
    const p = phase.get();
    return html`<dialog @cancel=${this.#onCancel}>
      ${g
        ? html`<div class="gate"><strong>${g.msg}</strong><div class="hint">${g.hint}</div></div>`
        : p === "reconnect"
          ? this.#reconnect()
          : p === "picker"
            ? this.#picker()
            : this.#steps()}
    </dialog>`;
  }

  // Open/close tracks the phase; the dialog element itself is stable across
  // renders, only its contents swap.
  protected override updated(): void {
    const d = this.renderRoot.querySelector("dialog")!;
    const open = gate.get() !== null || (phase.get() !== "shell" && phase.get() !== "boot");
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }

  #onCancel(e: Event): void {
    e.preventDefault(); // setup isn't skippable…
    if (phase.get() === "picker" && tabs.get().length > 0) dismissPicker(); // …but a done picker is
  }

  #header(): TemplateResult {
    return html`<header>
      <h1>fsio <span class="dim">/ terminal</span></h1>
      <p class="tagline">
        a terminal to your own machine, served from this page — transported
        through nothing but files in a folder.
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
        In a terminal, <code>cd</code> into a folder you're comfortable
        handing to this page, then:
      </p>
      <div class="cmd">
        <code>${CMD}</code>
        <button class="small" @click=${() => void navigator.clipboard.writeText(CMD)}>copy</button>
      </div>
      <p class="fineprint">
        ${onMac
          ? html`macOS only (for now). The shell you'll get is sandboxed to
              that folder: it can read the world, but writes anywhere else are
              denied — the policy is a plain text file the helper drops at
              <code>.fsio/sandbox.sb</code>.`
          : html`<strong>Heads up: the helper is macOS-only for now</strong>
              (its sandbox is built on Apple's Seatbelt). The page will
              connect from anywhere, but the helper side needs a Mac.`}
      </p>
      <div class="row">
        <button class="primary" @click=${() => wizardStep.set(2)}>I've run it — next</button>
        ${folder.get() && helper.get() === "silent"
          ? html`<span class="fineprint">${folder.get()!.name}/ is connected from last visit — waiting for the helper's heartbeat.</span>`
          : nothing}
      </div>
    `;
  }

  #stepPick(): TemplateResult {
    const err = pickError.get();
    const f = folder.get();
    const h = helper.get();
    return html`
      <p class="explain">
        Pick the <em>same folder</em> the helper is running in. Chrome will
        ask twice — once to view, once to save. That's the point:
        <em>you</em> are granting this page the folder, and nothing else.
      </p>
      <div class="row">
        <button class="ghost small" @click=${() => wizardStep.set(1)}>← back</button>
        <button class="primary" @click=${() => void pickFolder()}>Choose folder…</button>
        ${f ? html`<span class="fineprint">${f.name}/${f.via === "picked" ? "" : " (remembered from last visit)"}</span>` : nothing}
      </div>
      ${err ? html`<div class="status bad">${err.msg}<span class="hint">${err.hint}</span></div> ` : nothing}
      ${!err && f && h === "silent"
        ? html`<div class="status wait">
            folder connected, but no helper heartbeat
            <span class="hint">The helper writes a heartbeat every 2 seconds; we're not seeing it. Is it still running in this exact folder?</span>
          </div>`
        : nothing}
      ${!err && f && h === "alive" ? html`<div class="status ok">helper found — its heartbeat is in the folder</div>` : nothing}
    `;
  }

  #reconnect(): TemplateResult {
    const name = reconnectTo.get()?.name ?? "your folder";
    return html`${this.#header()}
      <h2>Welcome back</h2>
      <p class="explain">
        This page remembers <code>${name}/</code> from last visit. One click
        and you're back in — Chrome will just confirm the folder grant.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void regrant()}>Reconnect to ${name}/</button>
        <button class="ghost" @click=${() => { phase.set("wizard"); wizardStep.set(1); }}>use a different folder</button>
      </div>`;
  }

  #picker(): TemplateResult {
    // Filter against live tabs at render time so a just-resumed row
    // disappears immediately (the 2 s poll would lag behind the click).
    const held = new Set(tabs.get().filter((t) => t.session).map((t) => t.sessionId));
    const rows = resumable.get().filter((r) => !held.has(r.id));
    return html`${this.#header()}
      <h2>Your shells are still here</h2>
      <p class="explain">
        shells live in the helper, not the tab — closing the page doesn't end
        them. resume one (scrollback included), or start fresh. each resume
        opens its own tab.
      </p>
      ${rows.length === 0
        ? html`<p class="fineprint">no running shells right now — start a new one below.</p>`
        : rows.map(
            (r) => html`<div class="sess">
              <div class="sess-info">
                <code>${r.id}</code>
                <span class="hint">
                  ${r.status?.detached
                    ? "detached — no tab is holding it, safe to resume"
                    : `held by ${r.client ?? "another client"}${r.origin ? ` at ${r.origin}` : ""} — resuming takes it over (that tab keeps watching, read-only)`}
                </span>
              </div>
              <button class="small" @click=${() => openTab(r.id)}>resume</button>
            </div>`
          )}
      <div class="row">
        <button @click=${() => { openTab(); dismissPicker(); }}>Start a new shell</button>
        ${tabs.get().length > 0 ? html`<button class="primary" @click=${() => dismissPicker()}>To the terminal</button>` : nothing}
      </div>`;
  }
}

customElements.define("fsio-wizard", FsioWizard);
