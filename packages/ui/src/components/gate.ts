// The hard stop: a browser without the File System Access API, which is every
// demo here refusing at the door.
//
// All three pages had written the same three lines of it — the same red
// sentence, the same paragraph about why, and then nothing. That last part is
// the reason this is a component rather than a shared string: a dead end is a
// design, and it was the same dead end three times.
//
// What it can honestly offer is small and worth saying. The visitor cannot fix
// their browser from here, so the useful gesture is getting this page's address
// somewhere a Chromium browser can open it — which is a copy button, and it is
// the only thing standing between "I read about it" and "I saw it." Under that,
// where to go to read what it would have shown them.
//
// What it deliberately does NOT do is offer a degraded version of the page.
// There isn't one: without the API there is no folder, and without a folder
// there is no demo — every one of these is *about* the folder.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { tokens, icons } from "../tokens.js";

class FsioGate extends LitElement {
  static override properties = {
    msg: {},
    hint: {},
    copied: { state: true },
  };

  /** The red sentence: what is wrong. */
  msg = "";
  /** The paragraph under it: why, in terms of what the demo needs. */
  hint = "";
  copied = false;

  static override styles = [
    tokens,
    icons,
    css`
      :host { display: block; }
      strong { color: var(--fsio-bad-bright); display: block; }
      .hint { color: var(--fsio-bad); font-size: 0.9rem; margin-top: 0.4rem; }
      .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-top: 1.1rem; }
      button {
        display: flex; align-items: center; gap: 0.35rem;
        background: var(--fsio-control); color: var(--fsio-fg);
        border: 1px solid var(--fsio-line-control); border-radius: 6px;
        padding: 0.3rem 0.75rem; font: inherit; font-size: 0.85rem; cursor: pointer;
        box-shadow: var(--fsio-lift);
      }
      button:hover { background: var(--fsio-control-hover); }
      button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 2px; }
      .said { color: var(--fsio-good); font-size: 0.82rem; }
      .foot { margin-top: 0.9rem; color: var(--fsio-dimmer); font-size: 0.82rem; line-height: 1.5; }
      .foot a { color: var(--fsio-accent); }
      code { font-family: var(--fsio-mono); font-size: 0.8rem; color: var(--fsio-dim); }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <strong>${this.msg}</strong>
      <div class="hint">${this.hint}</div>
      <div class="row">
        <button @click=${this.#copy}>
          <span class="icon sm">content_copy</span>copy this page's link
        </button>
        ${this.copied
          ? html`<span class="said" role="status">copied — open it in Chrome</span>`
          : html`<code>${location.href}</code>`}
      </div>
      <div class="foot">
        Nothing here works without the folder, so there is no reduced version to
        show you — every one of these demos is <em>about</em> the folder. What
        it does and how it is built is written up at
        <a href="https://github.com/dglazkov/fsio">github.com/dglazkov/fsio</a>.
      </div>
    `;
  }

  #copy = (): void => {
    void navigator.clipboard.writeText(location.href).then(
      () => {
        this.copied = true;
        // Long enough to read, short enough that the address comes back for
        // anyone who wants to retype it instead.
        setTimeout(() => { this.copied = false; }, 4000);
      },
      () => {} // a browser that refuses the clipboard still shows the address
    );
  };
}

customElements.define("fsio-gate", FsioGate);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-gate": FsioGate;
  }
}
