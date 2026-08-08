// The shell: a bar naming the pewter, a strip of tabs, and the extension
// filling the rest.
//
// Almost nothing here is built in. The shell holds the tabs and provides the
// API; what fills one is an extension in the folder you granted, and this
// file's job is to give it a rectangle and stay out of it. The footer says
// what is in that rectangle — which extension, which bundle, and what it has
// asked the host for — because a screen you cannot tell apart from a built-in
// one is not evidence of anything.
//
// The stage's contents are not rendered here. Frames are appended to it by
// tabs.ts and hidden rather than moved, because moving an iframe reloads it
// and a tab that reset itself when a *different* tab closed would be a bug
// with no visible cause. This component owns the strip and the box; what is
// in the box is that module's.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens, panel } from "@fsio/ui";
import { bodyLabel } from "pewter";
import { forgetFolder, grantPending, pickFolder, regrant } from "../session";
import { extError, folder, gate, host, opaque, opened, pending, phase, pickError, reconnectTo, screens, screensError, served, tabs } from "../state";
import { answer, chipsOf, openFirst, setStage } from "../tabs";
import { loadExtensions } from "../extension";

/** The extension a fresh pewter opens with. The project list is not part of
 *  the product — it is `extensions/repos/`, and naming it here rather than
 *  hard-coding a screen is the whole difference. */
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
      .stage { flex: 1; min-height: 0; display: flex; position: relative; }
      /* One pane per tab, all of them attached, one of them shown. A pane is
         hidden rather than removed because the extension in it is still
         running — a shell keeps its pty, an agent keeps its conversation —
         and because taking a frame out of the document is how you lose one. */
      .stage .pane { flex: 1; min-height: 0; display: flex; }
      .stage .pane[hidden] { display: none; }
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
      .row { display: flex; gap: 0.6rem; }
      button.quiet { color: var(--fsio-dim); border-color: var(--fsio-line); }
      .bad { color: var(--fsio-bad-bright); white-space: pre-wrap; font-size: 0.8rem; line-height: 1.6; }
      footer {
        flex: none; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;
        padding: 0.3rem 0.9rem; border-top: 1px solid var(--fsio-line);
        background: var(--fsio-panel); font-size: 0.72rem; color: var(--fsio-dimmest);
      }
      /* The page's own door to an extension (#187). A disclosure, so it
         closes itself and needs no open-state here. */
      .opener { position: relative; flex: none; }
      .opener summary {
        list-style: none; cursor: pointer; user-select: none;
        padding: 0.1rem 0.5rem; border: 1px solid var(--fsio-line); border-radius: 6px;
        color: var(--fsio-dim); font-size: 0.9rem; line-height: 1.3;
      }
      .opener summary::-webkit-details-marker { display: none; }
      .opener summary:hover { color: var(--fsio-fg); border-color: var(--fsio-dim); }
      .opener[open] summary { color: var(--fsio-fg); }
      .opener .sheet {
        position: absolute; right: 0; top: calc(100% + 0.35rem); z-index: 20;
        min-width: 11rem; display: flex; flex-direction: column; gap: 0.1rem;
        padding: 0.35rem; border: 1px solid var(--fsio-line); border-radius: 8px;
        background: var(--fsio-panel);
      }
      .opener .sheet button {
        text-align: left; border-color: transparent; background: transparent;
        padding: 0.25rem 0.5rem; font-size: 0.78rem;
      }
      .opener .sheet button:hover:not(:disabled) { border-color: var(--fsio-line); }
      .opener .sheet button em { font-style: normal; color: var(--fsio-dimmest); }
      .opener .quiet-note { margin: 0; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: var(--fsio-dimmest); }
      footer .mark { color: var(--fsio-cyan); }
      footer .bad { font-size: 0.72rem; }
    `,
  ];

  #opened = false;

  override render(): TemplateResult {
    const blocked = gate.get();
    if (blocked) return html`<fsio-gate .msg=${blocked.msg} .hint=${blocked.hint}></fsio-gate>`;
    const live = phase.get() === "live";
    return html`
      <fsio-top-bar .name=${folder.get() ? `${folder.get()}/` : "pewter"} suffix=${folder.get() ? "" : "· no folder yet"}>
        ${live ? this.#strip() : nothing}
        ${live ? this.#opener() : nothing}
      </fsio-top-bar>
      ${live ? this.#live() : this.#setup()}
    `;
  }

  /** The tabs, in the bar the folder name is in.
   *
   *  Slotted rather than given a bar of its own, which is where the other two
   *  pages put theirs — and not only for consistency: the strip measures its
   *  own box to decide how many chips fit, and `fsio-top-bar`'s `::slotted(*)`
   *  is what gives it the width of the row. In a plain flex container it is
   *  as wide as its chips, so it concludes that one of them does not fit and
   *  moves it into "1 more" on a bar with room to spare.
   *
   *  No status dot on a chip: a tab here is a screen, not a session, and a
   *  light that is always the same colour is decoration. */
  #strip(): TemplateResult {
    const { tabs: list, activeId } = tabs.get();
    return html`<fsio-tab-strip
      .chips=${chipsOf(list)}
      .activeId=${activeId}
      .showList=${false}
      label="tabs in this pewter"
      @select=${(e: CustomEvent<{ id: string }>) => void answer("tabs.focus", { id: e.detail.id })}
      @close=${(e: CustomEvent<{ id: string }>) => void answer("tabs.close", { id: e.detail.id })}
    ></fsio-tab-strip>`;
  }

  /** The page's own door to an extension (#187).
   *
   *  Before this, the shell opened one extension per page load and every tab
   *  after that came from a command — an extension calling `pewt.tabs.add()`,
   *  or `pewt tabs add` in a terminal. Close the last tab and both doors were
   *  gone from the page, and the one screen that could have asked was the one
   *  you just closed. What was left was a terminal, which is not a thing a
   *  page should require.
   *
   *  In `slot="status"` rather than beside the strip, and that matters: the
   *  strip measures its own box to decide how many chips fit, and the bar's
   *  `::slotted(*) { flex: 1 }` is what gives it the row's width. A sibling in
   *  the default slot would make it as wide as its chips and it would start
   *  hiding tabs on a bar with room to spare. The status slot is `flex: none`.
   *
   *  A native `<details>` rather than a popover: it closes on its own, it is
   *  keyboard-reachable, and it needs no state here for whether it is open. */
  #opener(): TemplateResult {
    const list = screens.get();
    const failed = screensError.get();
    return html`<details
      slot="status"
      class="opener"
      @toggle=${(e: Event) => {
        // Asked on every open, never cached: the folder is the list, and a
        // screen an agent wrote a minute ago should be on it without a reload.
        if ((e.target as HTMLDetailsElement).open) void loadExtensions();
      }}
    >
      <summary title="open an extension" aria-label="open an extension">+</summary>
      <div class="sheet">
        ${failed
          ? html`<p class="bad">${failed}</p>`
          : list === null
            ? html`<p class="quiet-note">asking the host…</p>`
            : list.length === 0
              ? html`<p class="quiet-note">extensions/ is empty — nothing to open.</p>`
              : list.map(
                  (e) => html`
                    <button
                      ?disabled=${!e.ready}
                      title=${e.ready ? `open ${e.name}` : `extensions/${e.name}/ has no ${e.missing}`}
                      @click=${(ev: Event) => {
                        (ev.target as HTMLElement).closest("details")?.removeAttribute("open");
                        void answer("tabs.add", { name: e.name });
                      }}
                    >
                      ${e.name}${e.ready ? nothing : html`<em> — no ${e.missing}</em>`}
                    </button>
                  `
                )}
      </div>
    </details>`;
  }

  /** Three faces, in precedence order: a drop waiting for its allow, the
   *  folder this page held last time (revisit — one click back, F15), and
   *  the picker. A drop outranks the offer: it is the fresher gesture. */
  #setup(): TemplateResult {
    const waiting = pending.get();
    const remembered = reconnectTo.get();
    if (waiting) {
      return this.#panel(
        `Allow ${waiting.name}/`,
        html`Dropping the folder handed this page a reference to it. Reading and writing it is a
          second answer, and only you can give it — which is what stops the page from reaching
          anything you did not choose.`,
        html`<button id="grant" @click=${() => void grantPending()}>Allow this folder</button>`
      );
    }
    if (remembered) {
      return this.#panel(
        `Reconnect to ${remembered.name}/?`,
        html`This page held that pewter last time. Chrome remembers the folder, but reading and
          writing it again is a fresh answer, and only you can give it.`,
        html`<span class="row">
          <button id="reconnect" @click=${() => void regrant()}>Reconnect</button>
          <button class="quiet" @click=${() => void forgetFolder()}>Not this folder</button>
        </span>`
      );
    }
    return this.#panel(
      "Pick your pewter",
      html`A pewter is one folder on your machine that is a git repository, an npm project, and
        the channel to this page at once. Start its host with <code>npm start</code>, then hand
        the folder over: drag it onto this page, or pick it below.`,
      html`<button @click=${() => void pickFolder()}>Pick a folder</button>`
    );
  }

  #panel(title: string, prose: TemplateResult, action: TemplateResult): TemplateResult {
    return html`
      <main>
        <article>
          <h1>${title}</h1>
          <p>${prose}</p>
          ${action}
          ${pickError.get() ? html`<p class="bad">${pickError.get()}</p>` : nothing}
        </article>
      </main>
    `;
  }

  #live(): TemplateResult {
    const { tabs: list, activeId, held } = tabs.get();
    const shown = activeId ? opened.get()[activeId] : undefined;
    // A file tab has no bundle behind it, so the footer says what it is
    // instead. `bodyLabel` is the same reading `pewt tabs` prints in a
    // terminal, which is the point of it living in the shared package.
    const active = list.find((t) => t.id === activeId);
    const calls = served.get();
    const last = calls[calls.length - 1];
    return html`
      <div class="stage" id="stage"></div>
      ${extError.get() ? html`<main><article><h1>${FIRST}</h1><p class="bad">${extError.get()}</p></article></main>` : nothing}
      <footer>
        ${shown
          ? html`<span><span class="mark">▸</span> ${shown.name} · ${shown.bytes} B · ${shown.hash}${shown.rebuilt ? " · rebuilt" : ""}</span>`
          : active
            ? html`<span><span class="mark">▸</span> ${bodyLabel(active.body)}</span>`
            : html`<span>${list.length ? "nothing on screen" : this.#opened ? "no tabs open — the + in the bar opens one" : `opening ${FIRST}…`}</span>`}
        <span>${list.length} ${list.length === 1 ? "tab" : "tabs"}</span>
        ${held.length ? html`<span>${held.length} held</span>` : nothing}
        <span>${opaque.get() === null ? "frame not loaded" : opaque.get() ? "own origin" : "SAME ORIGIN — the sandbox is not holding"}</span>
        <span>host ${host.get()}</span>
        ${last ? html`<span>${last.method} → ${last.ok ? "ok" : "refused"} (${last.ms} ms)</span>` : nothing}
      </footer>
    `;
  }

  override updated(): void {
    // The stage exists only once the shell is live, and the first extension
    // opens once per page load. Everything after it is a command — from the
    // strip, from an extension, or from a terminal — and none of those come
    // through here.
    if (this.#opened || phase.get() !== "live") return;
    const stage = this.renderRoot.querySelector<HTMLElement>("#stage");
    if (!stage) return;
    this.#opened = true;
    setStage(stage);
    void openFirst(FIRST);
  }
}

customElements.define("pewter-shell", PewterShell);
