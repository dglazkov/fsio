// The terminal pane (#34): a shadow frame around slotted, light-DOM xterm
// hosts. tabs.ts appends one .term-host div per tab as a light child of
// this element and moves slot="active" between them — unslotted children
// aren't rendered, so exactly one terminal is in layout. xterm's DOM never
// enters a shadow root (character measurement / selection stay sane), and
// the global xterm.css applies untouched.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { controls, tokens } from "@fsio/ui";
import { phase, tabs, activeTab, notice } from "../state";
import { openTab, restartTab, retakeTab, closeTab } from "../tabs";

class FsioTerminalPane extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    controls,
    css`
      :host { display: block; position: relative; background: var(--fsio-bg); overflow: hidden; }
      .area { position: absolute; inset: 0.6rem; }
      ::slotted(.term-host) { display: block; width: 100%; height: 100%; }
      .idle {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #23272f; font-size: 3rem; font-weight: 700; user-select: none;
      }
      .center {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      }
      .card {
        background: var(--fsio-panel); border: 1px solid var(--fsio-line-strong);
        border-radius: 10px; padding: 1.1rem 1.3rem; max-width: 26rem; text-align: center;
      }
      .card .what { color: var(--fsio-fg); margin-bottom: 0.8rem; }
      .card .row { justify-content: center; margin-top: 0; }
      .banner {
        position: absolute; top: 0.6rem; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 0.7rem; max-width: min(38rem, 92%);
        border-radius: 8px; padding: 0.5rem 0.8rem; font-size: 0.88rem; z-index: 2;
      }
      .banner.warn { background: #3b3226; border: 1px solid var(--fsio-warn-quiet); }
      .banner.err { background: #3b2326; border: 1px solid var(--fsio-bad); }
      .banner.err strong { color: var(--fsio-bad-bright); }
      .banner .hint { color: #d8b9bc; font-size: 0.82rem; }
      .banner .x { background: none; border: none; color: inherit; padding: 0 0.3rem; }
      .banner .x:hover { background: none; }
    `,
  ];

  override render(): TemplateResult {
    const t = activeTab.get();
    const n = notice.get();
    const st = t?.state.get();
    return html`
      ${tabs.get().length === 0 ? html`<div class="idle">fsio</div>` : nothing}
      <div class="area"><slot name="active"></slot></div>
      ${n
        ? html`<div class="banner err">
            <span><strong>${n.msg}</strong><span class="hint"> ${n.hint}</span></span>
            <button class="x" @click=${() => notice.set(null)}>×</button>
          </div>`
        : nothing}
      ${st === "superseded"
        ? html`<div class="banner warn">
            <span>another tab (or window) took this shell over — you're watching read-only now.</span>
            <button @click=${() => void retakeTab(t!)}>take it back</button>
          </div>`
        : nothing}
      ${st === "exited" || st === "failed"
        ? html`<div class="center">
            <div class="card">
              <div class="what">${t!.detail.get()}</div>
              <div class="row">
                <button class="primary" @click=${() => restartTab(t!)}>
                  ${st === "failed" ? "try a fresh shell here" : "restart shell"}
                </button>
                <button @click=${() => void closeTab(t!)}>close tab</button>
              </div>
            </div>
          </div>`
        : nothing}
      ${tabs.get().length === 0 && phase.get() === "shell"
        ? html`<div class="center">
            <div class="card">
              <div class="what">no shells running in this tab strip</div>
              <div class="row"><button class="primary" @click=${() => openTab()}>start a shell</button></div>
            </div>
          </div>`
        : nothing}
    `;
  }
}

customElements.define("fsio-terminal-pane", FsioTerminalPane);
