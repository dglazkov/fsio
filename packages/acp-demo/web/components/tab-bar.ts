// The tab strip (#120): N conversations, and the "+" that finds the ones
// this page isn't holding.
//
// Two things on a chip that a shell tab would not need, both because an
// agent is not a shell. `asking` is the load-bearing one: this whole demo
// exists because the agent's consent question becomes page UI (R6), and a
// question asked in a background tab is that demo failing silently. `unread`
// is the quieter version of the same point — with one conversation the page
// WAS the notification.
//
// The "×" ends the conversation and stops the agent, and it asks first. That
// is #120's decision 2, and the reason it is not the walk-away is #120's
// decision 3: N tabs here is N model bills and N sandboxed child processes,
// where the terminal demo's N tabs is N ptys. "Leave running" is the other
// gesture, named on the same menu, because both meanings are real and a
// single button that guessed would be wrong half the time.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { activeId, convs, joinable, phase, viewing, type Adoptable, type Conv } from "../state";
import { activate } from "../conversations";
import { adoptSession, endSession, leaveSession, refreshJoinable, startAnother } from "../connection";
import { sinceLabel } from "../../src/discovery.js";

class AcpTabBar extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex; align-items: stretch; gap: 0.25rem;
      padding: 0 0.6rem; background: #14161a;
      border-bottom: 1px solid #262b34; font-size: 0.83rem;
      position: relative;
    }
    .tab {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.35rem 0.5rem 0.35rem 0.7rem; cursor: pointer;
      border: 1px solid transparent; border-bottom: none;
      border-radius: 7px 7px 0 0; color: #7b8598; max-width: 15rem;
      margin-bottom: -1px;
    }
    .tab:hover { color: #d8dee9; }
    .tab.on {
      background: #191c22; border-color: #262b34; color: #eceff4;
    }
    .tab .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .dot.thinking { background: #88c0d0; }
    .dot.gone { background: #6b3b40; }
    .dot.unread { background: #5e81ac; }
    /* Taken over (D18). Amber, not red: it is still running and still
       readable — it is just not this window's to drive. */
    .dot.fenced { background: #ebcb8b; }
    .tab.fenced .who { color: #9a8756; }
    .tab.fenced.on .who { color: #ebcb8b; }
    /* An unanswered consent question is the one thing a background tab has
       to be able to shout — it is what the demo is about. */
    .badge {
      background: #5e81ac; color: #eceff4; border-radius: 999px;
      font-size: 0.7rem; padding: 0 0.35rem; font-weight: 600; flex: none;
    }
    .x {
      background: none; border: none; color: #5c6675; cursor: pointer;
      font-size: 0.95rem; line-height: 1; padding: 0 0.15rem; border-radius: 4px;
    }
    .x:hover { color: #ef8a95; background: #3b2226; }
    .menu {
      background: none; border: none; color: #5c6675; cursor: pointer;
      font-size: 0.9rem; line-height: 1; padding: 0 0.15rem;
    }
    .menu:hover { color: #d8dee9; }
    .plus {
      background: none; border: none; color: #7b8598; cursor: pointer;
      font: inherit; font-size: 1rem; padding: 0.2rem 0.6rem; align-self: center;
      border-radius: 6px;
    }
    .plus:hover { color: #d8dee9; background: #191c22; }
    .spacer { flex: 1; }
    .pop {
      position: absolute; left: 0.6rem; top: 2.1rem; z-index: 30;
      background: #1c1f26; border: 1px solid #2c313c; border-radius: 8px;
      padding: 0.7rem 0.9rem; width: min(34rem, 92vw); max-height: 60vh; overflow: auto;
      line-height: 1.45;
    }
    .pop h3 { margin: 0 0 0.2rem; font-size: 0.82rem; color: #88c0d0; }
    .pop .explain { color: #7b8598; margin: 0 0 0.6rem; font-size: 0.8rem; }
    .pop .row {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.4rem 0; border-top: 1px solid #22262e;
    }
    .pop .row .who { flex: 1; min-width: 0; }
    .pop .row .name { color: #d8dee9; font-weight: 500; }
    .pop .row .when, .pop .row .said { color: #7b8598; font-size: 0.8rem; }
    .pop .row .said { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pop .row .stuck { color: #d9b477; font-size: 0.8rem; }
    .pop button {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 6px; padding: 0.25rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer;
    }
    .pop button:hover { background: #3b4252; }
    .pop button.primary { background: #5e81ac; border-color: #5e81ac; color: #eceff4; }
    .pop button.wide { width: 100%; margin-top: 0.6rem; }
    .pop .danger { color: #ef8a95; }
    .ask {
      position: absolute; left: 0.6rem; top: 2.1rem; z-index: 31;
      background: #1c1f26; border: 1px solid #6b3b40; border-radius: 8px;
      padding: 0.7rem 0.9rem; width: min(28rem, 92vw); line-height: 1.45;
    }
    .ask p { margin: 0 0 0.6rem; font-size: 0.85rem; }
    .ask .dim { color: #7b8598; font-size: 0.8rem; }
    .ask .row { display: flex; gap: 0.5rem; }
    .ask button {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 6px; padding: 0.3rem 0.8rem; font: inherit; font-size: 0.83rem; cursor: pointer;
    }
    .ask button.danger { border-color: #6b3b40; color: #ef8a95; }
    .ask button.danger:hover { background: #3b2226; color: #ffd7db; }
  `;

  /** Which conversation's close is being confirmed, or "". */
  #closing = "";
  /** Which conversation's menu is open, or "". */
  #menu = "";
  #plusOpen = false;

  /** Nothing rendered still leaves a bordered, padded host box, so the strip
   *  hides itself rather than leaving a stripe over an empty page. */
  protected override updated(): void {
    this.toggleAttribute("hidden", !this.renderRoot.querySelector(".tab, .plus"));
  }

  override render(): TemplateResult | typeof nothing {
    const list = convs.get();
    // Reading a past conversation takes over the whole pane (#119); a tab
    // strip under it would offer to switch to something that is not on
    // screen. And before there is a folder there is nothing to have tabs of.
    if (viewing.get() || (phase.get() !== "chat" && !list.length)) return nothing;
    return html`
      ${list.map((c) => this.#tab(c))}
      <button class="plus" title="another conversation in this folder" @click=${() => this.#togglePlus()}>+</button>
      <span class="spacer"></span>
      ${this.#closing ? this.#confirm() : nothing}
      ${this.#plusOpen ? this.#plus() : nothing}
      ${this.#menu ? this.#tabMenu() : nothing}
    `;
  }

  #tab(c: Conv): TemplateResult {
    const on = c.id === activeId.get();
    const t = c.turn.get();
    const asking = c.asking.get();
    const unread = c.unread.get();
    const fenced = !!c.superseded.get();
    return html`<div
      class="tab ${on ? "on" : ""} ${fenced ? "fenced" : ""}"
      title=${fenced ? `${c.id} — another window is driving this one` : c.id}
      @click=${() => activate(c.id)}
    >
      ${fenced
        ? html`<span class="dot fenced" title="another window took this conversation over"></span>`
        : asking
          ? html`<span class="badge" title="the agent is waiting for an answer here">${asking}</span>`
          : html`<span class="dot ${t === "thinking" || t === "starting" ? "thinking" : t === "gone" ? "gone" : unread ? "unread" : ""}"></span>`}
      <span class="who">${c.title.get()}</span>
      ${on && t !== "gone"
        ? html`<button class="menu" title="what to do with this conversation" @click=${(e: Event) => this.#openMenu(e, c.id)}>⋯</button>`
        : nothing}
      <button
        class="x"
        title=${t === "gone" ? "close this tab — the agent has already stopped" : "end this conversation — the agent stops"}
        @click=${(e: Event) => this.#askClose(e, c.id)}
      >×</button>
    </div>`;
  }

  #askClose(e: Event, id: string): void {
    e.stopPropagation();
    this.#menu = "";
    this.#plusOpen = false;
    // Nothing to lose and nothing to ask: this agent already exited, so the
    // "×" is just putting away a transcript. The confirm is for the case
    // where the click costs something.
    if (convs.get().find((c) => c.id === id)?.turn.get() === "gone") {
      this.#closing = "";
      this.requestUpdate();
      void endSession(id, true);
      return;
    }
    this.#closing = id;
    this.requestUpdate();
  }

  #openMenu(e: Event, id: string): void {
    e.stopPropagation();
    this.#menu = this.#menu === id ? "" : id;
    this.#plusOpen = false;
    this.requestUpdate();
  }

  /** The one irreversible gesture on the page, so it is the one that asks —
   *  and it names the alternative rather than burying it in a tooltip. The
   *  failure this prevents is someone reaching for "×" out of tab-habit and
   *  stopping an agent they meant to leave working. */
  #confirm(): TemplateResult {
    const c = convs.get().find((x) => x.id === this.#closing);
    const name = c?.title.get() ?? "this agent";
    return html`<div class="ask">
      <p>Close this conversation? <strong>${name}</strong> stops, and it does not come back.</p>
      <p class="dim">
        To keep it running and come back to it later, use “leave it running”
        instead — it stays in this folder and in the “+” menu. What was said
        here is kept either way: “past conversations” in the bar above.
      </p>
      <div class="row">
        <button class="danger" @click=${() => this.#close()}>Close it — stop ${name}</button>
        <button @click=${() => { this.#closing = ""; this.requestUpdate(); }}>Cancel</button>
      </div>
    </div>`;
  }

  #close(): void {
    const id = this.#closing;
    this.#closing = "";
    this.requestUpdate();
    void endSession(id, true);
  }

  #tabMenu(): TemplateResult {
    const id = this.#menu;
    return html`<div class="pop">
      <h3>this conversation</h3>
      <div class="row">
        <span class="who">
          <span class="name">leave it running</span>
          <div class="when">The agent keeps working. This page stops holding it, and it shows up under “+” — here or in any browser you open this folder in.</div>
        </span>
        <button @click=${() => { this.#menu = ""; this.requestUpdate(); void leaveSession(id); }}>Leave</button>
      </div>
      <div class="row">
        <span class="who">
          <span class="name danger">end it</span>
          <div class="when">Stops the agent for good. What it said stays readable under “past conversations”.</div>
        </span>
        <button @click=${(e: Event) => { this.#menu = ""; this.#askClose(e, id); }}>End…</button>
      </div>
    </div>`;
  }

  #togglePlus(): void {
    this.#plusOpen = !this.#plusOpen;
    this.#menu = "";
    this.#closing = "";
    this.requestUpdate();
    // Asked when the menu opens rather than polled: the answer is a
    // directory listing plus a read per session, and nobody needs it until
    // somebody wants to know.
    if (this.#plusOpen) void refreshJoinable();
  }

  /** The "+" menu. Its list is the arrival picker's, asked with one
   *  exclusion instead of two (#117's `listAdoptable`): the human is the one
   *  asking here, so a conversation they walked away from earlier is exactly
   *  what they might be looking for. */
  #plus(): TemplateResult {
    const rows = joinable.get();
    return html`<div class="pop">
      <h3>another conversation</h3>
      <p class="explain">
        Agents live in the helper, not in this page. These are running in this
        folder right now and no tab here is holding them — from an earlier
        visit, another browser, or one you left running.
      </p>
      ${rows.map((r) => this.#offer(r))}
      ${rows.length ? nothing : html`<p class="explain">Nothing else is running here.</p>`}
      <button class="primary wide" @click=${() => { this.#plusOpen = false; this.requestUpdate(); void startAnother(); }}>
        Start a new conversation
      </button>
    </div>`;
  }

  #offer(r: Adoptable): TemplateResult {
    return html`<div class="row">
      <span class="who">
        <span class="name">${r.agentName || r.agent || "an agent"}</span>
        <div class="when">
          ${sinceLabel(r.startedAt, Date.now())} ·
          ${r.detached ? "left running — no page is holding it" : `held by ${r.client || "another page"}, so joining takes it over`}
        </div>
        ${r.lastLine ? html`<div class="said" title=${r.lastLine}>${r.lastLine}</div>` : nothing}
        ${r.blocked ? html`<div class="stuck">${r.blocked}</div>` : nothing}
      </span>
      ${r.blocked
        ? nothing
        : html`<button @click=${() => { this.#plusOpen = false; this.requestUpdate(); void adoptSession(r.id); }}>Join</button>`}
    </div>`;
  }
}

customElements.define("acp-tab-bar", AcpTabBar);
