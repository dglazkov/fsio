import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fsio/ui";
import { LitElement, css, html, nothing } from "lit";
import { tokens, panel, installPageTheme, type Chip } from "@fsio/ui";
import type { TabState } from "../src/model";
import { applyCommand, loadState, setState } from "./db";
import { openChannel, scan, type Channel } from "./channel";
import { reporter, step } from "./reporter";

installPageTheme();

class ActuatorApp extends LitElement {
  static override properties = { state: { attribute: false }, connected: { type: Boolean }, activity: {} };
  declare state: TabState;
  declare connected: boolean;
  declare activity: string;
  #channel: Channel | null = null;
  #timer = 0;

  constructor() {
    super();
    this.state = { tabs: [], activeId: null };
    this.connected = false;
    this.activity = "Choose the helper's workspace to begin applying queued commands.";
    reporter.summary = () => this.state.tabs.map((tab) => ({ ...tab, active: tab.id === this.state.activeId }));
  }

  static override styles = [tokens, panel, css`
    :host { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; background: var(--fsio-bg); color: var(--fsio-fg); font-family: "JetBrains Mono", monospace; }
    header { display: flex; gap: 1rem; align-items: center; min-width: 0; padding: .65rem 1rem; border-bottom: 1px solid var(--fsio-line); background: var(--fsio-panel); }
    .brand { font-family: "Instrument Serif", serif; font-size: 1.55rem; white-space: nowrap; }
    fsio-tab-strip { flex: 1; min-width: 0; }
    button { border: 1px solid var(--fsio-line-strong); border-radius: 7px; padding: .45rem .7rem; background: var(--fsio-raised); color: var(--fsio-fg); cursor: pointer; font: inherit; }
    main { display: grid; place-items: center; padding: 3rem; }
    article { width: min(42rem, 100%); border: 1px solid var(--fsio-line); border-radius: 14px; padding: 2rem; background: var(--fsio-panel); box-shadow: 0 20px 60px rgb(0 0 0 / .16); }
    h1 { margin: 0 0 1rem; font: 400 2.4rem/1.05 "Instrument Serif", serif; color: var(--fsio-fg-bright); }
    .message { line-height: 1.7; white-space: pre-wrap; }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--fsio-line); color: var(--fsio-dimmer); font-size: .78rem; }
    .empty { text-align: center; color: var(--fsio-dimmer); }
  `];

  override async connectedCallback(): Promise<void> { super.connectedCallback(); this.state = await loadState(); }
  override disconnectedCallback(): void { super.disconnectedCallback(); clearInterval(this.#timer); }

  async #choose(): Promise<void> {
    try {
      const root = await window.showDirectoryPicker({ mode: "readwrite" });
      this.#channel = await openChannel(root);
      await reporter.attach(this.#channel.fsio);
      this.connected = true;
      this.activity = `Connected to ${root.name}; checking queued commands.`;
      step(`connected to ${root.name}`);
      await this.#poll();
      clearInterval(this.#timer);
      this.#timer = window.setInterval(() => void this.#poll(), 350);
    } catch (error) { this.activity = error instanceof Error ? error.message : String(error); }
  }

  async #poll(): Promise<void> {
    if (!this.#channel) return;
    // Web Locks elects one executor when several tabs share this origin/IDB.
    await navigator.locks.request("fsio-actuator-demo-executor", { ifAvailable: true }, async (lock) => {
      if (!lock || !this.#channel) return;
      const count = await scan(this.#channel, async (command) => {
        const result = await applyCommand(command);
        this.state = await loadState();
        this.activity = `${command.method} · ${result.status} · ${command.id}`;
        reporter.event("command", { id: command.id, method: command.method, status: result.status });
        step(`${command.method} ${result.status}`);
        return result;
      });
      if (count) this.requestUpdate();
    });
  }

  async #activate(id: string): Promise<void> { this.state = { ...this.state, activeId: id }; await setState(this.state); }
  async #remove(id: string): Promise<void> {
    const tabs = this.state.tabs.filter((tab) => tab.id !== id);
    this.state = { tabs, activeId: this.state.activeId === id ? (tabs[0]?.id ?? null) : this.state.activeId };
    await setState(this.state);
  }

  override render() {
    const chips: Chip[] = this.state.tabs.map((tab) => ({ id: tab.id, name: tab.title, title: `${tab.title} (${tab.id})`, closeTitle: "remove this tab" }));
    const active = this.state.tabs.find((tab) => tab.id === this.state.activeId);
    return html`
      <header>
        <div class="brand">fsio /actuator</div>
        <fsio-tab-strip .chips=${chips} .activeId=${this.state.activeId} .showList=${false}
          label="application tabs" @select=${(event: CustomEvent<{id: string}>) => void this.#activate(event.detail.id)}
          @close=${(event: CustomEvent<{id: string}>) => void this.#remove(event.detail.id)}></fsio-tab-strip>
        <button @click=${this.#choose}>${this.connected ? "Change folder" : "Choose folder"}</button>
        <fsio-theme-switch></fsio-theme-switch>
      </header>
      <main>${active ? html`<article><h1>${active.title}</h1><div class="message">${active.message}</div><footer>${this.activity}</footer></article>` : html`<div class="empty">No tabs. Queue one with <code>actuator tabs add</code>.</div>`}</main>
      ${nothing}
    `;
  }
}
customElements.define("actuator-app", ActuatorApp);
