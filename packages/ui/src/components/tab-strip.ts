// The strip of chips: what this page has open, and the list that finds what
// it doesn't.
//
// Both pages grew one of these. The agent page's grew further — a real
// tablist with arrow keys, a top-layer confirm, a per-chip menu, an overflow
// scroller, popovers that close when you click away — and the terminal's
// stayed a row of divs with a native `confirm()` behind its "×". This is the
// agent page's, with every string it used to hardcode lifted into a prop, so
// the terminal gets all of the above and neither page gets the other's words.
//
// The split that makes that work: **this component owns mechanics, the demo
// owns prose and consequences.** Focus, roving tabindex, scrolling the active
// chip into view, the top layer, Escape, click-away, which dot is which shape
// — here. What a chip is called, what closing one costs, and what happens
// when you do — there.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { Dismiss } from "../dismiss.js";
import { tokens, panel, icons } from "../tokens.js";

/** Which dot a chip wears. Each is a state the thing is currently IN, which
 *  is why the ordinary healthy state has none: an idle agent and a shell
 *  sitting at a prompt are not doing anything worth a light.
 *
 *  busy — working (cyan) · unread — has said things you haven't read (blue) ·
 *  gone — stopped (dark red) · fenced — another window drives it now (amber,
 *  not red: still running, still readable, just not yours) · bad — it failed
 *  · doc — hollow, because a finished transcript is the absence of any state
 *  rather than one more of them. */
export type ChipDot = "" | "busy" | "unread" | "gone" | "fenced" | "bad" | "doc";

export interface Chip {
  /** the session id — the strip's identity for this thing, and what every
   *  event carries back. */
  id: string;
  /** the headline: what this thing is called. */
  name: string;
  /** a quieter fact, shown on the active chip only (the agent's name, say).
   *  First thing to go when the bar is tight. */
  secondary?: string;
  dot?: ChipDot;
  /** unanswered questions. Sits BESIDE the dot rather than replacing it:
   *  "it is waiting" and "it has said things you have not read" are two
   *  facts, not one slot. 0 draws nothing. */
  badge?: number;
  /** tooltip on the chip, tooltip on the dot, tooltip on the "×". */
  title?: string;
  dotTitle?: string;
  closeTitle?: string;
  /** italic name — this one is a document, not a live session. */
  quiet?: boolean;
}

/** What to say before doing the thing that does not come back. Returning null
 *  from `confirmFor` means this close costs nothing and should just happen. */
export interface ConfirmCopy {
  question: string | TemplateResult;
  /** the second paragraph: what to do INSTEAD. A confirm that only says "are
   *  you sure" has told the person nothing they didn't know. */
  note?: string | TemplateResult;
  /** the destructive button's label. */
  confirm: string;
}

/** A row in a chip's "⋯" menu. */
export interface ChipAction {
  /** comes back in the `action` event's detail. */
  id: string;
  name: string;
  note: string;
  /** the button's label. */
  button: string;
  danger?: boolean;
}

class FsioTabStrip extends LitElement {
  static override properties = {
    chips: { attribute: false },
    activeId: {},
    confirmFor: { attribute: false },
    menuFor: { attribute: false },
    label: {},
    listTitle: {},
    showList: { type: Boolean },
  };

  chips: Chip[] = [];
  activeId: string | null = null;
  /** What closing this one costs, or null when it costs nothing. */
  confirmFor: ((chip: Chip) => ConfirmCopy | null) | null = null;
  /** What else can be done with this one. An empty array draws no "⋯". */
  menuFor: ((chip: Chip) => ChipAction[]) | null = null;
  /** aria-label for the tablist. */
  label = "open sessions";
  /** tooltip on the "+". */
  listTitle = "everything in this folder";
  showList = true;

  /** Which chip's close is being confirmed, or "". */
  #closing = "";
  /** Which chip's menu is open, or "". */
  #menu = "";
  #listOpen = false;
  /** Set when a keyboard move has changed the active chip and the newly
   *  active one has to take the focus with it — otherwise the arrow keys move
   *  the selection out from under the focus ring. */
  #takeFocus = false;

  constructor() {
    super();
    new Dismiss(this, () => this.#menu !== "" || this.#listOpen, () => this.dismiss());
  }

  static override styles = [
    tokens,
    panel,
    icons,
    css`
      /* A row inside a bar, not a strip under one. No background, no border
         and no padding of its own: the bar it sits in owns all three, and a
         second surface inside one row is what makes a bar look like two. */
      :host {
        display: flex; align-items: center; gap: 0.25rem;
        font-size: 0.83rem; position: relative;
      }
      /* The host's own display beats the UA sheet's [hidden], and a page
         stylesheet cannot reach into a shadow root. */
      :host([hidden]) { display: none !important; }
      /* Enough chips and they run off the edge, so the chips — and only the
         chips — scroll. "+" sits outside the scroller because a control that
         scrolls away is a control the page does not have. */
      .strip {
        display: flex; align-items: stretch; gap: 0.25rem;
        flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;
        padding: 1px 0;
        scrollbar-width: thin; scrollbar-color: var(--fsio-line-strong) transparent;
      }
      .strip::-webkit-scrollbar { height: 3px; }
      .strip::-webkit-scrollbar-thumb { background: var(--fsio-line-strong); border-radius: 3px; }
      /* A pill, not a folder tab. A folder tab wants a pane edge directly
         beneath it to attach to; sharing a row with the folder name, there
         is not one. */
      .tab {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.25rem 0.4rem 0.25rem 0.6rem; cursor: pointer;
        border: 1px solid transparent; border-radius: 7px; color: var(--fsio-dimmer);
        flex: 0 1 auto; min-width: 7.5rem; max-width: 16rem;
        scroll-margin: 0 1rem;
      }
      .tab:hover { color: var(--fsio-fg); }
      .tab.on { background: var(--fsio-raised); border-color: var(--fsio-line); color: var(--fsio-fg-bright); }
      .tab:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: -2px; }
      .tab .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tab .secondary {
        color: var(--fsio-dimmest); font-size: 0.76rem; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0;
      }
      .tab.on .secondary { color: var(--fsio-dimmer); }
      .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
      .dot.busy { background: var(--fsio-cyan); }
      .dot.unread { background: var(--fsio-accent); }
      .dot.gone { background: var(--fsio-bad-line); }
      .dot.bad { background: var(--fsio-bad); }
      .dot.fenced { background: var(--fsio-warn); }
      .dot.doc { background: none; box-shadow: inset 0 0 0 1.5px var(--fsio-dimmest); }
      .tab.fenced .who { color: var(--fsio-warn-quiet); }
      .tab.fenced.on .who { color: var(--fsio-warn); }
      .tab.doc .who { font-style: italic; }
      .badge {
        background: var(--fsio-accent); color: var(--fsio-on-accent); border-radius: 999px;
        font-size: 0.7rem; padding: 0 0.35rem; font-weight: 600; flex: none;
      }
      .x {
        background: none; border: none; color: var(--fsio-dimmest); cursor: pointer;
        display: flex; align-items: center; padding: 0.1rem; border-radius: 4px;
        flex: none;
      }
      .x .icon { font-size: 0.95rem; }
      .x:hover { color: var(--fsio-bad-bright); background: var(--fsio-bad-wash); }
      .menu {
        background: none; border: none; color: var(--fsio-dimmest); cursor: pointer;
        display: flex; align-items: center; padding: 0.1rem; border-radius: 4px;
        flex: none;
      }
      .menu .icon { font-size: 1rem; }
      .menu:hover { color: var(--fsio-fg); }
      .plus {
        background: none; border: none; color: var(--fsio-dimmer); cursor: pointer;
        display: flex; align-items: center; padding: 0.25rem 0.45rem; align-self: center;
        border-radius: 6px; flex: none;
      }
      .plus:hover, .plus:focus-visible { color: var(--fsio-fg); background: var(--fsio-raised); }
      .spacer { flex: 1; }
      .pop { position: absolute; left: 0; top: calc(100% + 0.55rem); z-index: 30; }
      /* The "⋯" menu is rendered here rather than slotted, so its innards are
         styled here. The "+" list's are not — that content belongs to the
         demo, and a shadow root cannot reach across the slot. */
      .pop h3 { margin: 0 0 0.5rem; font-size: 0.82rem; color: var(--fsio-cyan); font-weight: 600; }
      .pop button {
        background: var(--fsio-control); color: var(--fsio-fg);
        border: 1px solid var(--fsio-line-control); border-radius: 6px;
        padding: 0.25rem 0.7rem; font: inherit; font-size: 0.82rem;
        cursor: pointer; flex: none;
      }
      .pop button:hover { background: var(--fsio-control-hover); }
      .pop .row {
        display: flex; align-items: center; gap: 0.6rem;
        padding: 0.4rem 0; border-top: 1px solid var(--fsio-line);
      }
      .pop .row .who { flex: 1; min-width: 0; }
      .pop .row .name { color: var(--fsio-fg); font-weight: 500; }
      .pop .row .name.danger { color: var(--fsio-bad-bright); }
      .pop .row .note { color: var(--fsio-dimmer); font-size: 0.8rem; }
      /* A real dialog: the one irreversible gesture on the page gets the top
         layer, Escape, and a focus trap the browser owns, instead of an
         absolutely-positioned panel inside this strip's stacking context —
         and instead of window.confirm(), which is the same idea with none of
         the page's words in it. */
      dialog.ask {
        background: var(--fsio-float); border: 1px solid var(--fsio-bad-line);
        border-radius: 8px; padding: 0.9rem 1.1rem; width: min(28rem, 92vw);
        line-height: 1.45; color: var(--fsio-fg); font: inherit; font-size: 0.85rem;
      }
      dialog.ask::backdrop { background: light-dark(#3a302233, #0000005c); }
      dialog.ask p { margin: 0 0 0.6rem; }
      dialog.ask .dim { color: var(--fsio-dimmer); font-size: 0.8rem; }
      dialog.ask .row { display: flex; gap: 0.5rem; }
      dialog.ask button {
        background: var(--fsio-control); color: var(--fsio-fg);
        border: 1px solid var(--fsio-line-control); border-radius: 6px;
        padding: 0.3rem 0.8rem; font: inherit; font-size: 0.83rem; cursor: pointer;
      }
      dialog.ask button.danger { border-color: var(--fsio-bad-line); color: var(--fsio-bad-bright); }
      dialog.ask button.danger:hover { background: var(--fsio-bad-wash); border-color: var(--fsio-bad); }
    `,
  ];

  /** Put any open popover away. Public because the bar around this one has to
   *  be able to close it — a click that switches chips should not leave a
   *  menu hanging over the new one. */
  dismiss(): void {
    this.#menu = "";
    this.#listOpen = false;
    this.requestUpdate();
  }

  /** Nothing rendered still leaves a host box in layout, so the strip hides
   *  itself rather than leaving a gap in the bar. */
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

  override render(): TemplateResult {
    return html`
      <div class="strip" role="tablist" aria-label=${this.label} @keydown=${this.#nav}>
        ${this.chips.map((c) => this.#chip(c))}
      </div>
      ${this.showList
        ? html`<button
            class="plus"
            title=${this.listTitle}
            aria-haspopup="dialog"
            aria-expanded=${this.#listOpen}
            @click=${this.#toggleList}
          ><span class="icon">add</span></button>`
        : nothing}
      <span class="spacer"></span>
      ${this.#closing ? this.#confirm() : nothing}
      ${this.#listOpen ? html`<div class="pop"><slot name="list"></slot></div>` : nothing}
      ${this.#menu ? this.#chipMenu() : nothing}
    `;
  }

  #chip(c: Chip): TemplateResult {
    const on = c.id === this.activeId;
    const dot = c.dot ?? "";
    const actions = this.menuFor?.(c) ?? [];
    return html`<div
      class="tab ${on ? "on" : ""} ${dot === "fenced" ? "fenced" : ""} ${c.quiet ? "doc" : ""}"
      role="tab"
      aria-selected=${on}
      tabindex=${on ? 0 : -1}
      title=${c.title ?? ""}
      @click=${() => { this.dismiss(); this.#emit("select", c.id); }}
    >
      <span class="dot ${dot}" title=${c.dotTitle ?? ""}></span>
      ${c.badge
        ? html`<span class="badge" title="waiting for an answer here">${c.badge}</span>`
        : nothing}
      <span class="who">${c.name}</span>
      ${on && c.secondary ? html`<span class="secondary">${c.secondary}</span>` : nothing}
      ${on && actions.length
        ? html`<button
            class="menu"
            tabindex="-1"
            title="what else to do with this one"
            @click=${(e: Event) => this.#openMenu(e, c.id)}
          ><span class="icon">more_horiz</span></button>`
        : nothing}
      <button class="x" tabindex="-1" title=${c.closeTitle ?? "close"} @click=${(e: Event) => this.#askClose(e, c.id)}><span class="icon">close</span></button>
    </div>`;
  }

  /** The tablist's keyboard. Arrow keys move and switch in one gesture — the
   *  sessions are already all live, so there is nothing to commit to — and
   *  Delete closes the focused one, which is the ARIA pattern for a deletable
   *  tab and lands on the same confirm the "×" does. Delete only, never
   *  Backspace: the gesture can stop a running thing, and Backspace is the
   *  key people press meaning "back". */
  #nav = (e: KeyboardEvent): void => {
    const list = this.chips;
    const i = list.findIndex((c) => c.id === this.activeId);
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
    this.#emit("select", list[to]!.id);
    this.requestUpdate();
  };

  #emit(type: string, id: string, extra: Record<string, unknown> = {}): void {
    this.dispatchEvent(new CustomEvent(type, { detail: { id, ...extra }, bubbles: true, composed: true }));
  }

  #askClose(e: Event, id: string): void {
    e.stopPropagation();
    this.#menu = "";
    this.#listOpen = false;
    const chip = this.chips.find((c) => c.id === id);
    const copy = chip && this.confirmFor ? this.confirmFor(chip) : null;
    // Nothing to lose and nothing to ask. The confirm is for the case where
    // the click costs something.
    if (!copy) {
      this.#closing = "";
      this.requestUpdate();
      this.#emit("close", id);
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

  /** The one irreversible gesture, so it is the one that asks — and it names
   *  the alternative rather than burying it in a tooltip. The failure this
   *  prevents is someone reaching for "×" out of tab-habit and stopping
   *  something they meant to leave running. */
  #confirm(): TemplateResult {
    const chip = this.chips.find((c) => c.id === this.#closing);
    const copy = chip && this.confirmFor ? this.confirmFor(chip) : null;
    if (!copy) return html`${nothing}`;
    return html`<dialog class="ask" @close=${() => { this.#closing = ""; this.requestUpdate(); }}>
      <p>${copy.question}</p>
      ${copy.note ? html`<p class="dim">${copy.note}</p>` : nothing}
      <div class="row">
        <button class="danger" autofocus @click=${this.#close}>${copy.confirm}</button>
        <button @click=${() => { this.#closing = ""; this.requestUpdate(); }}>Cancel</button>
      </div>
    </dialog>`;
  }

  #close = (): void => {
    const id = this.#closing;
    this.#closing = "";
    this.requestUpdate();
    this.#emit("close", id);
  };

  #chipMenu(): TemplateResult {
    const id = this.#menu;
    const chip = this.chips.find((c) => c.id === id);
    const actions = chip ? (this.menuFor?.(chip) ?? []) : [];
    return html`<div class="pop">
      <h3>${chip?.name ?? ""}</h3>
      ${actions.map(
        (a) => html`<div class="row">
          <span class="who">
            <span class="name ${a.danger ? "danger" : ""}">${a.name}</span>
            <div class="note">${a.note}</div>
          </span>
          <button @click=${(e: Event) => this.#act(e, id, a)}>${a.button}</button>
        </div>`
      )}
    </div>`;
  }

  #act(e: Event, id: string, a: ChipAction): void {
    this.#menu = "";
    this.requestUpdate();
    // A destructive menu row lands on the same confirm the "×" does rather
    // than firing straight through — two doors, one lock.
    if (a.danger) this.#askClose(e, id);
    else this.#emit("action", id, { action: a.id });
  }

  #toggleList = (): void => {
    this.#listOpen = !this.#listOpen;
    this.#menu = "";
    this.requestUpdate();
    // Asked when the list opens rather than polled: the answer is a directory
    // listing plus a read per session, and nobody needs it until somebody
    // wants to know.
    if (this.#listOpen) this.dispatchEvent(new CustomEvent("list-open", { bubbles: true, composed: true }));
  };
}

customElements.define("fsio-tab-strip", FsioTabStrip);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-tab-strip": FsioTabStrip;
  }
}
