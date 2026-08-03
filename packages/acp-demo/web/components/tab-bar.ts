// The tab strip (#120): N conversations, and the list that finds the ones
// this page isn't holding.
//
// Two things on a chip that a shell tab would not need, both because an
// agent is not a shell. `asking` is the load-bearing one: this whole demo
// exists because the agent's consent question becomes page UI (#18), and a
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
//
// #140's pass made this bar the conversation layer outright. The top bar had
// been carrying a second copy of the active conversation — its agent's name,
// and an "end conversation" that was the chip's "×" under another label —
// which with one conversation read as a header and with N read as ambiguity
// about which layer owned what. So: the chip owns the conversation, the top
// bar owns the folder, and the two lists of conversations that used to sit on
// opposite sides of that line ("+" here, "past" up there) are one list with
// two states. They were always one list — a conversation does not become a
// different object by ending — and #119 is what made that true in the data:
// the transcript keeps the session's own id, so a conversation keeps its name
// after it stops.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { activeId, convs, joinable, past, phase, type Adoptable, type Conv, type PastConversation } from "../state";
import { activate } from "../conversations";
import { adoptSession, currentRoot, endSession, leaveSession, refreshJoinable, startAnother } from "../connection";
import { openPast, refreshPast } from "../history";
import { friendlyName } from "../names";
import { sinceLabel } from "../../src/discovery.js";
import { isTail } from "../../src/transcripts.js";

class AcpTabBar extends SignalWatcher(LitElement) {
  static override styles = css`
    /* A row inside the top bar, not a strip under it (#140). No background,
       no border and no padding of its own: the bar it sits in owns all
       three, and a second surface inside one row is what made this look like
       two bars in the first place. */
    :host {
      display: flex; align-items: center; gap: 0.25rem;
      font-size: 0.83rem; position: relative;
    }
    /* The host's own display beats the UA sheet's [hidden], and index.html's
       override cannot reach into a shadow root. */
    :host([hidden]) { display: none !important; }
    /* Enough conversations and the chips run off the edge, so the chips —
       and only the chips — scroll. "+" sits outside the scroller because a
       control that scrolls away is a control the page does not have. */
    .strip {
      display: flex; align-items: stretch; gap: 0.25rem;
      flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 1px 0;
      scrollbar-width: thin; scrollbar-color: #2c313c transparent;
    }
    .strip::-webkit-scrollbar { height: 3px; }
    .strip::-webkit-scrollbar-thumb { background: #2c313c; border-radius: 3px; }
    /* A pill, not a folder tab. The old shape had a square bottom and a
       -1px margin so it sat ON the strip's bottom border, which is the right
       drawing when there is a pane edge directly beneath it to attach to.
       Sharing a row with the folder name, there is not. */
    .tab {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.25rem 0.4rem 0.25rem 0.6rem; cursor: pointer;
      border: 1px solid transparent; border-radius: 7px; color: #7b8598;
      flex: 0 1 auto; min-width: 7.5rem; max-width: 16rem;
      scroll-margin: 0 1rem;
    }
    .tab:hover { color: #d8dee9; }
    .tab.on {
      background: #191c22; border-color: #262b34; color: #eceff4;
    }
    .tab:focus-visible { outline: 2px solid #5e81ac; outline-offset: -2px; }
    .tab .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The agent's name, on the chip that is on screen. It is a different
       fact from the conversation's name — three chips can say "claude" — so
       it is quieter, and it is the first thing to go when the bar is tight. */
    .tab .agent {
      color: #5c6675; font-size: 0.76rem; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0;
    }
    .tab.on .agent { color: #7b8598; }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .dot.thinking { background: #88c0d0; }
    .dot.gone { background: #6b3b40; }
    .dot.unread { background: #5e81ac; }
    /* Taken over (D18). Amber, not red: it is still running and still
       readable — it is just not this window's to drive. */
    .dot.fenced { background: #ebcb8b; }
    .tab.fenced .who { color: #9a8756; }
    .tab.fenced.on .who { color: #ebcb8b; }
    /* A document (#140). Hollow rather than filled: every other dot on this
       strip is a state something is currently in, and this one is the absence
       of any state at all — the conversation is over. */
    .dot.doc { background: none; box-shadow: inset 0 0 0 1.5px #5c6675; }
    .tab.doc .who { font-style: italic; }
    /* An unanswered consent question is the one thing a background tab has
       to be able to shout — it is what the demo is about. It sits BESIDE the
       status dot rather than replacing it (#140 question 4): an agent that
       asked something and then kept talking was showing only the badge, and
       "it is waiting" and "it has said things you have not read" are two
       facts, not one slot. */
    .badge {
      background: #5e81ac; color: #eceff4; border-radius: 999px;
      font-size: 0.7rem; padding: 0 0.35rem; font-weight: 600; flex: none;
    }
    .x {
      background: none; border: none; color: #5c6675; cursor: pointer;
      font-size: 0.95rem; line-height: 1; padding: 0 0.15rem; border-radius: 4px;
      flex: none;
    }
    .x:hover { color: #ef8a95; background: #3b2226; }
    .menu {
      background: none; border: none; color: #5c6675; cursor: pointer;
      font-size: 0.9rem; line-height: 1; padding: 0 0.15rem; flex: none;
    }
    .menu:hover { color: #d8dee9; }
    .plus {
      background: none; border: none; color: #7b8598; cursor: pointer;
      font: inherit; font-size: 1rem; padding: 0.2rem 0.6rem; align-self: center;
      border-radius: 6px; flex: none;
    }
    .plus:hover, .plus:focus-visible { color: #d8dee9; background: #191c22; }
    .spacer { flex: 1; }
    .pop {
      position: absolute; left: 0; top: calc(100% + 0.55rem); z-index: 30;
      background: #1c1f26; border: 1px solid #2c313c; border-radius: 8px;
      padding: 0.7rem 0.9rem; width: min(34rem, 92vw); max-height: 60vh; overflow: auto;
      line-height: 1.45;
    }
    .pop h3 { margin: 0.7rem 0 0.2rem; font-size: 0.82rem; color: #88c0d0; }
    .pop h3:first-child { margin-top: 0; }
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
      flex: none;
    }
    .pop button:hover { background: #3b4252; }
    .pop button.primary { background: #5e81ac; border-color: #5e81ac; color: #eceff4; }
    .pop button.wide { width: 100%; margin-top: 0.6rem; }
    .pop .danger { color: #ef8a95; }
    /* A real dialog (#140 question 2): the one irreversible gesture on the
       page gets the top layer, Escape, and a focus trap the browser owns,
       instead of an absolutely-positioned panel inside the tab bar's own
       stacking context. */
    dialog.ask {
      background: #1c1f26; border: 1px solid #6b3b40; border-radius: 8px;
      padding: 0.9rem 1.1rem; width: min(28rem, 92vw); line-height: 1.45;
      color: #d8dee9; font: inherit; font-size: 0.85rem;
    }
    dialog.ask::backdrop { background: rgba(10, 12, 15, 0.55); }
    dialog.ask p { margin: 0 0 0.6rem; }
    dialog.ask .dim { color: #7b8598; font-size: 0.8rem; }
    dialog.ask .row { display: flex; gap: 0.5rem; }
    dialog.ask button {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 6px; padding: 0.3rem 0.8rem; font: inherit; font-size: 0.83rem; cursor: pointer;
    }
    dialog.ask button.danger { border-color: #6b3b40; color: #ef8a95; }
    dialog.ask button.danger:hover { background: #3b2226; color: #ffd7db; }
  `;

  /** Which conversation's close is being confirmed, or "". */
  #closing = "";
  /** Which conversation's menu is open, or "". */
  #menu = "";
  #listOpen = false;
  /** Set when a keyboard move has changed the active chip and the newly
   *  active one has to take the focus with it — otherwise the arrow keys
   *  move the selection out from under the focus ring. */
  #takeFocus = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this.#esc);
    document.addEventListener("click", this.#outside, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.#outside, true);
    super.disconnectedCallback();
  }

  /** Escape and a click anywhere else both put a popover away. Neither used
   *  to (#140 question 5): the only way to close one was to hit the control
   *  that opened it, which is a trap with a pointer and a dead end without. */
  #esc = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !(this.#menu || this.#listOpen)) return;
    e.stopPropagation();
    this.#dismiss();
  };

  #outside = (e: Event): void => {
    if (!(this.#menu || this.#listOpen)) return;
    if (e.composedPath().includes(this)) return;
    this.#dismiss();
  };

  /** Nothing rendered still leaves a bordered, padded host box, so the strip
   *  hides itself rather than leaving a stripe over an empty page. */
  protected override updated(): void {
    this.toggleAttribute("hidden", !this.renderRoot.querySelector(".tab, .plus"));
    const dialog = this.renderRoot.querySelector("dialog.ask") as HTMLDialogElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    const on = this.renderRoot.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null;
    if (!on) return;
    if (this.#takeFocus) {
      this.#takeFocus = false;
      on.focus();
    }
    // A chip switched to from the "+" list, or from the URL, may be off the
    // scrolled edge — switching to something you cannot see is the overflow
    // bug wearing a different hat.
    on.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  override render(): TemplateResult | typeof nothing {
    const list = convs.get();
    // Before there is a folder there is nothing to have tabs of. Reading a
    // past conversation used to be the other reason to hide — it took over
    // the whole pane, so a strip under it would have offered to switch to
    // something that was not on screen. A document is a chip now (#140), so
    // it is exactly what the strip is for.
    if (phase.get() !== "chat" && !list.length) return nothing;
    return html`
      <div class="strip" role="tablist" aria-label="conversations in this folder" @keydown=${this.#nav}>
        ${list.map((c) => this.#tab(c))}
      </div>
      <button class="plus" title="the conversations in this folder" aria-haspopup="dialog" aria-expanded=${this.#listOpen} @click=${() => this.#toggleList()}>+</button>
      <span class="spacer"></span>
      ${this.#closing ? this.#confirm() : nothing}
      ${this.#listOpen ? this.#list() : nothing}
      ${this.#menu ? this.#tabMenu() : nothing}
    `;
  }

  #tab(c: Conv): TemplateResult {
    const on = c.id === activeId.get();
    const t = c.turn.get();
    const asking = c.asking.get();
    const unread = c.unread.get();
    const fenced = !!c.superseded.get();
    const doc = !!c.doc;
    const name = friendlyName(c.id);
    const agent = c.title.get();
    return html`<div
      class="tab ${on ? "on" : ""} ${fenced ? "fenced" : ""} ${doc ? "doc" : ""}"
      role="tab"
      aria-selected=${on}
      tabindex=${on ? 0 : -1}
      title=${doc
        ? `${name} · ${agent} — a conversation that ended, read-only (${c.id})`
        : fenced
          ? `${name} · ${agent} — another window is driving this one (${c.id})`
          : `${name} · ${agent} (${c.id})`}
      @click=${() => { this.#dismiss(); activate(c.id); }}
    >
      <span
        class="dot ${doc ? "doc" : fenced ? "fenced" : t === "thinking" || t === "starting" ? "thinking" : t === "gone" ? "gone" : unread ? "unread" : ""}"
        title=${doc
          ? "this conversation is over — what you are reading is the transcript"
          : fenced
            ? "another window took this conversation over"
            : t === "gone"
              ? "this agent has stopped"
              : unread
                ? "it has said things you have not read"
                : ""}
      ></span>
      ${asking ? html`<span class="badge" title="the agent is waiting for an answer here">${asking}</span>` : nothing}
      <span class="who">${name}</span>
      ${on ? html`<span class="agent">${doc ? `${agent} · read-only` : agent}</span>` : nothing}
      ${on && !doc && t !== "gone"
        ? html`<button class="menu" tabindex="-1" title="what to do with this conversation" @click=${(e: Event) => this.#openMenu(e, c.id)}>⋯</button>`
        : nothing}
      <button
        class="x"
        tabindex="-1"
        title=${doc
          ? "put this transcript away — it stays in the folder"
          : t === "gone"
            ? "close this tab — the agent has already stopped"
            : "end this conversation — the agent stops"}
        @click=${(e: Event) => this.#askClose(e, c.id)}
      >×</button>
    </div>`;
  }

  /** The tablist's keyboard (#140 question 5): nothing here used to be
   *  reachable without a pointer. Arrow keys move and switch in one gesture
   *  — the conversations are already all live, so there is nothing to commit
   *  to — and Delete closes the focused one, which is the ARIA pattern for a
   *  deletable tab and lands on the same confirm the "×" does. Delete only,
   *  never Backspace: the gesture stops an agent, and Backspace is the key
   *  people press meaning "back". */
  #nav = (e: KeyboardEvent): void => {
    const list = convs.get();
    const i = list.findIndex((c) => c.id === activeId.get());
    if (i < 0) return;
    let to = -1;
    if (e.key === "ArrowRight") to = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") to = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    else if (e.key === "Delete") {
      e.preventDefault();
      this.#askClose(e, list[i]!.id);
      return;
    } else return;
    e.preventDefault();
    this.#takeFocus = true;
    activate(list[to]!.id);
    this.requestUpdate();
  };

  #dismiss(): void {
    this.#menu = "";
    this.#listOpen = false;
    this.requestUpdate();
  }

  #askClose(e: Event, id: string): void {
    e.stopPropagation();
    this.#menu = "";
    this.#listOpen = false;
    // Nothing to lose and nothing to ask: this agent already exited, so the
    // "×" is just putting away a transcript. The confirm is for the case
    // where the click costs something.
    // A document costs nothing to close either — the transcript is in the
    // folder and "+" lists it — so it goes the same way (#140).
    const c = convs.get().find((x) => x.id === id);
    if (c?.doc || c?.turn.get() === "gone") {
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
    this.#listOpen = false;
    this.requestUpdate();
  }

  /** The one irreversible gesture on the page, so it is the one that asks —
   *  and it names the alternative rather than burying it in a tooltip. The
   *  failure this prevents is someone reaching for "×" out of tab-habit and
   *  stopping an agent they meant to leave working. */
  #confirm(): TemplateResult {
    const c = convs.get().find((x) => x.id === this.#closing);
    const name = friendlyName(this.#closing);
    const agent = c?.title.get() ?? "the agent";
    return html`<dialog class="ask" @close=${() => { this.#closing = ""; this.requestUpdate(); }}>
      <p>Close <strong>${name}</strong>? ${agent} stops, and it does not come back.</p>
      <p class="dim">
        To keep it running and come back to it later, use “leave it running”
        instead — it stays in this folder and in the “+” list. What was said
        here is kept either way: it moves to the ended half of that same list.
      </p>
      <div class="row">
        <button class="danger" autofocus @click=${() => this.#close()}>Close it — stop ${agent}</button>
        <button @click=${() => { this.#closing = ""; this.requestUpdate(); }}>Cancel</button>
      </div>
    </dialog>`;
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
      <h3>${friendlyName(id)}</h3>
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
          <div class="when">Stops the agent for good. What it said stays readable in the “+” list, under the conversations that have ended.</div>
        </span>
        <button @click=${(e: Event) => { this.#menu = ""; this.#askClose(e, id); }}>End…</button>
      </div>
    </div>`;
  }

  #toggleList(): void {
    this.#listOpen = !this.#listOpen;
    this.#menu = "";
    this.requestUpdate();
    if (!this.#listOpen) return;
    // Asked when the list opens rather than polled: the answer is a
    // directory listing plus a read per session, and nobody needs it until
    // somebody wants to know.
    void refreshJoinable();
    const root = currentRoot();
    if (root) void refreshPast(root).catch(() => {});
  }

  /** Every conversation in this folder, live and over (#140 question 3).
   *
   *  These used to be two lists with two owners — "+" here for the running
   *  ones, "past" in the top bar for the ended ones — and they are the same
   *  object in two states. The live half's rows are the arrival picker's,
   *  asked with one exclusion instead of two (#117's `listAdoptable`): the
   *  human is the one asking here, so a conversation they walked away from
   *  earlier is exactly what they might be looking for. */
  #list(): TemplateResult {
    const running = joinable.get();
    const ended = past.get();
    const root = currentRoot();
    return html`<div class="pop">
      <h3>conversations in this folder</h3>
      <p class="explain">
        Agents live in the helper, not in this page. Everything this folder
        knows about is here — what is running and no tab is holding, and what
        has already ended.
      </p>
      ${running.length ? html`<h3>still running</h3>` : nothing}
      ${running.map((r) => this.#running(r))}
      ${ended.length ? html`<h3>ended · ${ended.length}</h3>` : nothing}
      ${ended.map((p) => this.#ended(p, root))}
      ${running.length || ended.length
        ? nothing
        : html`<p class="explain">Nothing else is running here, and nothing has ended yet.</p>`}
      <button class="primary wide" @click=${() => { this.#listOpen = false; this.requestUpdate(); void startAnother(); }}>
        Start a new conversation
      </button>
    </div>`;
  }

  #running(r: Adoptable): TemplateResult {
    return html`<div class="row">
      <span class="who">
        <span class="name">${friendlyName(r.id)}</span>
        <div class="when">
          ${r.agentName || r.agent || "an agent"} ·
          ${sinceLabel(r.startedAt, Date.now())} ·
          ${r.detached ? "left running — no page is holding it" : `held by ${r.client || "another page"}, so joining takes it over`}
        </div>
        ${r.lastLine ? html`<div class="said" title=${r.lastLine}>${r.lastLine}</div>` : nothing}
        ${r.blocked ? html`<div class="stuck">${r.blocked}</div>` : nothing}
      </span>
      ${r.blocked
        ? nothing
        : html`<button @click=${() => { this.#listOpen = false; this.requestUpdate(); void adoptSession(r.id); }}>Join</button>`}
    </div>`;
  }

  /** An ended one. Read-only, and the agent's half only: prompts rode the
   *  uplink, which is not what the folder keeps (#119, D26 rule 4). It keeps
   *  the name it had while it was running, because the transcript keeps the
   *  session's id. */
  #ended(p: PastConversation, root: FileSystemDirectoryHandle | null): TemplateResult {
    return html`<div class="row">
      <span class="who">
        <span class="name">${friendlyName(p.id)}</span>
        <div class="when">
          ${p.agent || p.kind || "session"} ·
          ${p.ended ? new Date(p.ended).toLocaleString() : "ended"}${p.why ? ` · ${p.why}` : ""} ·
          ${sizeOf(p.bytes)}${isTail(p) ? " · tail only" : ""}
        </div>
      </span>
      <button
        ?disabled=${!root}
        title="the agent's half, replayed from what the helper kept"
        @click=${() => { this.#listOpen = false; this.requestUpdate(); if (root) void openPast(root, p); }}
      >Read</button>
    </div>`;
  }
}

const sizeOf = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

customElements.define("acp-tab-bar", AcpTabBar);
