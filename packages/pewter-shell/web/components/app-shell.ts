// The shell: a bar naming the pewter, and the extension filling the rest.
//
// Almost nothing here is built in. The shell holds the tab and provides the
// API; what fills the tab is `extensions/repos/` in the folder you granted,
// and this file's job is to give it a rectangle and stay out of it. The
// strip along the bottom says what is in that rectangle — which extension,
// which bundle, and what it has asked the host for — because a screen you
// cannot tell apart from a built-in one is not evidence of anything.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens, panel } from "@fsio/ui";
import { openExtension } from "../extension";
import { grantPending, pickFolder } from "../session";
import { extError, folder, gate, host, open, opaque, pending, phase, pickError, served } from "../state";

/** The extension a fresh pewter opens with. The project list is not part of
 *  the product — it is `extensions/repos/`, and naming it here rather than
 *  hard-coding a screen is the whole difference. Which extension opens, and
 *  a strip of tabs to hold several, is the next slice. */
const FIRST = "repos";

class PewterShell extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    panel,
    css`
      :host {
        display: flex; flex-direction: column; flex: 1; min-height: 0;
        background: var(--fsio-bg); color: var(--fsio-fg);
        font-family: var(--fsio-mono);
      }
      .stage { flex: 1; min-height: 0; display: flex; }
      /* The extension's rectangle. No border and no padding: what is in here
         is somebody's page, not a widget in ours. */
      .stage ::slotted(iframe), .stage iframe { flex: 1; border: 0; background: var(--fsio-bg); }
      main { flex: 1; min-height: 0; display: grid; place-items: center; padding: 2rem 1.5rem; }
      article { width: min(34rem, 100%); border: 1px solid var(--fsio-line); border-radius: 14px; padding: 2rem 2.2rem; background: var(--fsio-panel); }
      h1 { margin: 0 0 0.5rem; font: 400 2rem/1.05 var(--fsio-title); color: var(--fsio-fg-bright); }
      p { line-height: 1.7; font-size: 0.88rem; color: var(--fsio-dim); }
      button {
        font: inherit; font-size: 0.85rem; padding: 0.45rem 1rem; cursor: pointer;
        border-radius: 8px; border: 1px solid var(--fsio-line-strong);
        background: var(--fsio-control); color: var(--fsio-fg-bright);
      }
      button:hover { border-color: var(--fsio-control-hover); }
      button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 2px; }
      .bad { color: var(--fsio-bad-bright); white-space: pre-wrap; font-size: 0.8rem; line-height: 1.6; }
      footer {
        flex: none; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;
        padding: 0.3rem 0.9rem; border-top: 1px solid var(--fsio-line);
        background: var(--fsio-panel); font-size: 0.72rem; color: var(--fsio-dimmest);
      }
      footer .mark { color: var(--fsio-cyan); }
      footer .bad { font-size: 0.72rem; }
    `,
  ];

  #opened = false;

  override render(): TemplateResult {
    const blocked = gate.get();
    if (blocked) return html`<fsio-gate .msg=${blocked.msg} .hint=${blocked.hint}></fsio-gate>`;
    return html`
      <fsio-top-bar .name=${folder.get() ? `${folder.get()}/` : "pewter"} suffix=${folder.get() ? "" : "· no folder yet"}></fsio-top-bar>
      ${phase.get() === "live" ? this.#live() : this.#setup()}
    `;
  }

  #setup(): TemplateResult {
    const waiting = pending.get();
    return html`
      <main>
        <article>
          <h1>${waiting ? `Allow ${waiting.name}/` : "Pick your pewter"}</h1>
          <p>
            ${waiting
              ? html`Dropping the folder handed this page a reference to it. Reading and writing it is a
                  second answer, and only you can give it — which is what stops the page from reaching
                  anything you did not choose.`
              : html`A pewter is one folder on your machine that is a git repository, an npm project, and
                  the channel to this page at once. Start its host with <code>npm start</code>, then hand
                  the folder over: drag it onto this page, or pick it below.`}
          </p>
          ${waiting
            ? html`<button id="grant" @click=${() => void grantPending()}>Allow this folder</button>`
            : html`<button @click=${() => void pickFolder()}>Pick a folder</button>`}
          ${pickError.get() ? html`<p class="bad">${pickError.get()}</p>` : nothing}
        </article>
      </main>
    `;
  }

  #live(): TemplateResult {
    const shown = open.get();
    const calls = served.get();
    const last = calls[calls.length - 1];
    return html`
      <div class="stage" id="stage">${extError.get() ? html`<main><article><h1>${FIRST}</h1><p class="bad">${extError.get()}</p></article></main>` : nothing}</div>
      <footer>
        ${shown
          ? html`<span><span class="mark">▸</span> ${shown.name} · ${shown.bytes} B · ${shown.hash}${shown.rebuilt ? " · rebuilt" : ""}</span>`
          : html`<span>opening ${FIRST}…</span>`}
        <span>${opaque.get() === null ? "frame not loaded" : opaque.get() ? "own origin" : "SAME ORIGIN — the sandbox is not holding"}</span>
        <span>host ${host.get()}</span>
        ${last ? html`<span>${last.method} → ${last.ok ? "ok" : "refused"} (${last.ms} ms)</span>` : nothing}
      </footer>
    `;
  }

  override updated(): void {
    // The stage exists only once the shell is live, and the extension is
    // opened once per page load. A second call would rebuild a frame that is
    // already running — reloading a tab is the slice that gets to do that.
    if (this.#opened || phase.get() !== "live") return;
    const stage = this.renderRoot.querySelector<HTMLElement>("#stage");
    if (!stage) return;
    this.#opened = true;
    void openExtension(FIRST, stage);
  }
}

customElements.define("pewter-shell", PewterShell);
