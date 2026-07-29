// Status bar (#34): folder, helper heartbeat, active-tab status, the detach
// affordance, and the ⓘ popover holding the fine print + nerd log (moved
// out of the page body — the terminal owns the viewport now). The bar is
// also the natural slot for #28's transport garnish when that lands.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { phase, folder, helper, activeTab } from "../state";
import { logText } from "../reporter";
import { detachTab } from "../tabs";

class FsioStatusBar extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex; align-items: center; gap: 1rem;
      background: #1c1f26; border-top: 1px solid #2c313c;
      padding: 0.3rem 0.9rem; min-height: 2rem; font-size: 0.82rem;
      color: #9aa5b8; position: relative;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
    .chip { display: flex; align-items: center; gap: 0.4rem; white-space: nowrap; }
    .dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: #5c6675; flex: none; }
    .dot.ok { background: #7fb069; }
    .dot.wait { background: #d0a05a; }
    .detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa5b8; }
    button.small {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 5px; padding: 0.15rem 0.6rem; font: inherit; font-size: 0.78rem; cursor: pointer;
    }
    button.small:hover { background: #3b4252; }
    button.info {
      background: none; border: none; color: #81a1c1; cursor: pointer;
      font-size: 0.95rem; padding: 0 0.3rem; border-radius: 4px;
    }
    button.info:hover { background: #2e3440; }
    #info-pop {
      background: #1c1f26; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 10px; padding: 1rem 1.2rem; width: min(36rem, 92vw);
      position: absolute; inset: auto 0.5rem 2.4rem auto; margin: 0;
      font-size: 0.85rem; line-height: 1.5;
    }
    #info-pop h3 { margin: 0 0 0.5rem; font-size: 0.95rem; color: #eceff4; }
    #info-pop p { color: #9aa5b8; margin: 0 0 0.7rem; }
    #info-pop em { color: #d8dee9; font-style: normal; font-weight: 600; }
    #info-pop a { color: #81a1c1; }
    pre {
      background: #14161a; border-radius: 6px; padding: 0.8rem; margin: 0.4rem 0 0;
      overflow: auto; font-size: 0.75rem; line-height: 1.45; max-height: 11rem; color: #81a1c1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    summary { cursor: pointer; color: #81a1c1; font-size: 0.82rem; }
    .foot { color: #5c6675; font-size: 0.78rem; margin-top: 0.8rem; }
  `;

  override render(): TemplateResult {
    const f = folder.get();
    const h = helper.get();
    const t = activeTab.get();
    const connected = phase.get() === "shell" || phase.get() === "picker";
    return html`
      <span class="chip">${f ? html`<code>${f.name}/</code>` : html`no folder yet`}</span>
      ${connected
        ? html`<span class="chip">
            <span class="dot ${h === "alive" ? "ok" : "wait"}"></span>
            ${h === "alive" ? "helper" : "no heartbeat"}
          </span>`
        : nothing}
      <span class="detail">${t ? t.detail.get() : ""}</span>
      ${t && t.state.get() === "running"
        ? html`<button class="small" title="keep the shell running; the tab lets go" @click=${() => void detachTab(t)}>detach</button>`
        : nothing}
      <button class="info" popovertarget="info-pop" title="what is this?">ⓘ</button>
      <div id="info-pop" popover>
        <h3>what am I looking at?</h3>
        <p>
          A real shell on your machine — but this page has no server behind
          it. No websocket, no cloud, not even a localhost port. The only
          connection between this tab and the shell is <em>the folder you
          picked</em>: every keystroke is written to a file, a tiny helper
          reads it and feeds the shell, the shell's output is written to
          another file, and the page reads it back. The filesystem is the
          entire transport — fast enough that you didn't notice.
        </p>
        <p>
          Because the sessions themselves live in files, shells outlive the
          page: detach one and it keeps running with no tab attached; come
          back later and resume it, scrollback and all. Another window can
          even take a running shell over while you watch.
        </p>
        <p>
          And the folder is the whole deal in the other direction too: the
          shell is sandboxed to it. It can read the world, but writes
          anywhere else are denied — the policy is a plain text file at
          <code>.fsio/sandbox.sb</code>. (If your shell grumbled once about
          its history file, that was the sandbox saying no.)
        </p>
        <details>
          <summary>nerd log</summary>
          <button class="small" style="margin: 0.5rem 0" @click=${() => void navigator.clipboard.writeText(logText.get())}>
            copy log
          </button>
          <pre>${logText.get()}</pre>
        </details>
        <div class="foot">
          an <a href="https://github.com/dglazkov/fsio">fsio</a> demo · the
          measurement workbench lives in the repo (<code>scripts/dev.sh</code>)
        </div>
      </div>
    `;
  }

  protected override updated(): void {
    const pre = this.renderRoot.querySelector("pre");
    if (pre) pre.scrollTop = pre.scrollHeight;
  }
}

customElements.define("fsio-status-bar", FsioStatusBar);
