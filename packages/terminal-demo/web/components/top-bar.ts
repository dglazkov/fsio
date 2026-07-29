// Top chrome (#34): wordmark, session tabs, and the "+" menu (new shell /
// resume). Per-tab status rides the chip's dot; close is on the chip.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { phase, tabs, activeTabId, resumable } from "../state";
import { refreshResumable } from "../connection";
import { openTab, setActiveTab, closeTab } from "../tabs";
import type { TabRecord } from "../state";

class FsioTopBar extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex; align-items: center; gap: 1rem;
      background: #1c1f26; border-bottom: 1px solid #2c313c;
      padding: 0.4rem 0.9rem; min-height: 2.4rem; position: relative;
    }
    .wordmark { font-size: 0.95rem; font-weight: 600; white-space: nowrap; }
    .wordmark .dim { color: #5e81ac; font-weight: 400; }
    .tabs { display: flex; align-items: center; gap: 0.35rem; overflow-x: auto; flex: 1; min-width: 0; }
    .tab {
      display: flex; align-items: center; gap: 0.45rem; cursor: pointer;
      background: #14161a; border: 1px solid #2c313c; border-radius: 7px;
      padding: 0.25rem 0.4rem 0.25rem 0.7rem; font-size: 0.85rem;
      color: #9aa5b8; white-space: nowrap; user-select: none;
    }
    .tab.active { color: #eceff4; border-color: #4c566a; background: #2e3440; }
    .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #5c6675; flex: none; }
    .st-starting .dot { background: #5e81ac; }
    .st-running .dot { background: #7fb069; }
    .st-exited .dot { background: #5c6675; }
    .st-superseded .dot { background: #d0a05a; }
    .st-failed .dot { background: #bf616a; }
    .x {
      background: none; border: none; color: #5c6675; cursor: pointer;
      font-size: 0.95rem; padding: 0 0.25rem; border-radius: 4px; line-height: 1;
    }
    .x:hover { color: #eceff4; background: #3b4252; }
    .plus {
      background: none; border: 1px dashed #4c566a; color: #9aa5b8; cursor: pointer;
      border-radius: 7px; padding: 0.2rem 0.6rem; font-size: 0.95rem; line-height: 1.2;
      anchor-name: --plus;
    }
    .plus:hover { color: #eceff4; border-color: #81a1c1; }
    #plus-menu {
      background: #1c1f26; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 8px; padding: 0.5rem; min-width: 16rem; margin: 0;
      font-size: 0.85rem;
      /* Popovers live in the top layer, where the bar's position:relative
         can't reach them — anchor to the + button instead (Chrome-only
         page; browsers without anchor positioning get the centered
         default). */
      position: fixed; position-anchor: --plus;
      inset: auto; top: calc(anchor(bottom) + 0.3rem); left: anchor(left);
    }
    #plus-menu button {
      display: block; width: 100%; text-align: left; background: none;
      border: none; color: #d8dee9; font: inherit; cursor: pointer;
      border-radius: 5px; padding: 0.4rem 0.6rem;
    }
    #plus-menu button:hover { background: #2e3440; }
    #plus-menu button .hint { color: #9aa5b8; font-size: 0.78rem; display: block; }
    #plus-menu code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
    .menu-sep { color: #5c6675; font-size: 0.75rem; padding: 0.4rem 0.6rem 0.1rem; }
  `;

  override render(): TemplateResult {
    const list = tabs.get();
    const active = activeTabId.get();
    const connected = phase.get() === "shell" || phase.get() === "picker";
    return html`
      <div class="wordmark">fsio <span class="dim">/ terminal</span></div>
      <div class="tabs">
        ${list.map((t) => this.#tab(t, t.tabId === active))}
        ${connected
          ? html`<button class="plus" popovertarget="plus-menu" title="new shell / resume">+</button>`
          : nothing}
      </div>
      <div id="plus-menu" popover @toggle=${this.#onMenuToggle}>
        <button @click=${() => this.#pick(() => openTab())}>
          new shell<span class="hint">a fresh sandboxed shell in the same folder</span>
        </button>
        ${this.#resumeRows()}
      </div>
    `;
  }

  #tab(t: TabRecord, active: boolean): TemplateResult {
    return html`<div
      class="tab ${active ? "active" : ""} st-${t.state.get()}"
      title=${t.sessionId ?? ""}
      @click=${() => setActiveTab(t.tabId)}
    >
      <span class="dot"></span>
      <span>${t.title.get()}</span>
      <button class="x" title="close" @click=${(e: Event) => { e.stopPropagation(); void closeTab(t); }}>×</button>
    </div>`;
  }

  #resumeRows(): TemplateResult | typeof nothing {
    const held = new Set(tabs.get().filter((t) => t.session).map((t) => t.sessionId));
    const rows = resumable.get().filter((r) => !held.has(r.id));
    if (rows.length === 0) return nothing;
    return html`<div class="menu-sep">resume a running shell</div>
      ${rows.map(
        (r) => html`<button @click=${() => this.#pick(() => openTab(r.id))}>
          <code>${r.id}</code>
          <span class="hint">
            ${r.status?.detached ? "detached — safe to resume" : `held by ${r.client ?? "another client"} — resuming takes it over`}
          </span>
        </button>`
      )}`;
  }

  #pick(action: () => void): void {
    (this.renderRoot.querySelector("#plus-menu") as HTMLElement).hidePopover();
    action();
  }

  #onMenuToggle(e: Event): void {
    if ((e as ToggleEvent).newState === "open") void refreshResumable();
  }
}

customElements.define("fsio-top-bar", FsioTopBar);
