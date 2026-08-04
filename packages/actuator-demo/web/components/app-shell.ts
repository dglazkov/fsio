// The app being actuated: a bar naming the folder, the tabs in it, and the
// active tab's message under them.
//
// Deliberately an ordinary little application. Nothing in this file knows
// that a terminal exists — it renders page state and edits page state, and
// the commands arriving from the machine land in exactly the same place a
// click does (session.ts). That is the claim the demo is making, so the UI
// must not have a special "remote" path anywhere in it.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens, panel } from "@fsio/ui";
import type { Chip } from "@fsio/ui";
import { applyToApp } from "../db";
import { app, displaced, folder, helper, lastCommand, phase } from "../state";
import { logText } from "../reporter";
import "./setup";

class ActuatorApp extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    panel,
    css`
      :host {
        display: flex; flex-direction: column; flex: 1; min-height: 0;
        background: var(--fsio-bg); color: var(--fsio-fg);
        font-family: var(--fsio-mono);
      }
      header {
        display: flex; align-items: center; gap: 0.7rem;
        padding: 0.35rem 0.9rem; background: var(--fsio-panel);
        border-bottom: 1px solid var(--fsio-line);
      }
      .where { display: flex; align-items: baseline; gap: 0.4rem; min-width: 0; }
      .where .name {
        font-family: var(--fsio-title); font-size: 1.15rem;
        color: var(--fsio-fg-bright); white-space: nowrap;
      }
      .where .slash { color: var(--fsio-dimmest); }
      fsio-tab-strip { flex: 1; min-width: 0; }
      .spacer { flex: 1; }
      main { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: start center; padding: 3rem 1.5rem; }
      article {
        width: min(46rem, 100%); border: 1px solid var(--fsio-line); border-radius: 14px;
        padding: 2rem 2.2rem; background: var(--fsio-panel);
      }
      h1 { margin: 0 0 1.2rem; font: 400 2.3rem/1.05 var(--fsio-title); color: var(--fsio-fg-bright); }
      .message { line-height: 1.75; white-space: pre-wrap; font-size: 0.92rem; }
      .empty { color: var(--fsio-dimmer); text-align: center; padding-top: 3rem; }
      footer {
        display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
        padding: 0.45rem 0.9rem; border-top: 1px solid var(--fsio-line);
        background: var(--fsio-panel); font-size: 0.76rem; color: var(--fsio-dimmer);
      }
      .badge {
        border: 1px solid var(--fsio-line-strong); border-radius: 999px;
        padding: 0.05rem 0.5rem; color: var(--fsio-dimmer);
      }
      .badge.cli { color: var(--fsio-cyan); border-color: var(--fsio-cyan); }
      .badge.bad { color: var(--fsio-bad-bright); border-color: var(--fsio-bad-line); }
      code { color: var(--fsio-fg); }
    `,
  ];

  override render(): TemplateResult {
    const state = app.get();
    const active = state.tabs.find((t) => t.id === state.activeId);
    const chips: Chip[] = state.tabs.map((t) => ({
      id: t.id,
      name: t.title,
      title: `${t.title} · ${t.id}`,
      closeTitle: "remove this tab",
    }));
    const f = folder.get();
    return html`
      <header>
        <div class="where">
          <span class="name">${f ? f.name : "fsio"}</span>
          <span class="slash">/ actuator</span>
        </div>
        <fsio-tab-strip
          .chips=${chips}
          .activeId=${state.activeId}
          .showList=${false}
          label="tabs in this app"
          @select=${(e: CustomEvent<{ id: string }>) => void this.#run("tabs.activate", e.detail.id)}
          @close=${(e: CustomEvent<{ id: string }>) => void this.#run("tabs.remove", e.detail.id)}
        ></fsio-tab-strip>
        <div class="spacer"></div>
        <fsio-theme-switch></fsio-theme-switch>
        <fsio-details label="what this page is doing">
          <div style="white-space: pre-wrap; font-size: 0.75rem">${logText.get()}</div>
        </fsio-details>
      </header>

      <main>
        ${active
          ? html`<article>
              <h1>${active.title}</h1>
              <div class="message">${active.message}</div>
            </article>`
          : html`<div class="empty">
              No tabs. Add one from the folder:<br /><br />
              <code>actuator tabs add --title Build --message "CI is running"</code>
            </div>`}
      </main>

      <footer>${this.#status()}</footer>
      <actuator-setup></actuator-setup>
    `;
  }

  #status(): TemplateResult {
    const last = lastCommand.get();
    const h = helper.get();
    const live = phase.get() === "live" && !displaced.get();
    return html`
      <span class="badge ${live ? "cli" : ""}"
        >${displaced.get()
          ? "another page holds this folder"
          : live && h === "alive"
            ? "listening for commands"
            : h === "silent"
              ? "helper silent"
              : "not connected"}</span
      >
      ${last
        ? html`<span class="badge ${last.ok ? "" : "bad"}">${last.origin === "cli" ? "from the folder" : "from this page"}</span>
            <span>${last.method} — ${last.detail}</span>`
        : html`<span>nothing has happened yet</span>`}
    `;
  }

  /** A click here is the same operation the CLI sends — same reducer, same
   *  store, same signal. The only difference is what the footer says about
   *  where it came from. */
  async #run(method: "tabs.activate" | "tabs.remove", id: string): Promise<void> {
    try {
      await applyToApp({ method, params: { id } } as never);
      lastCommand.set({ method, ok: true, detail: id, origin: "page" });
    } catch (e) {
      lastCommand.set({ method, ok: false, detail: e instanceof Error ? e.message : String(e), origin: "page" });
    }
  }
}

customElements.define("actuator-app", ActuatorApp);
