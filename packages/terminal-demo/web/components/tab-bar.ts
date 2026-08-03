// The shells in this folder: N chips, and the list that finds the ones this
// page isn't holding.
//
// The strip is `@fsio/ui`'s, so this page now has what the agent demo's had
// and this one never did — a real tablist with arrow keys, an overflow
// scroller, popovers that close when you click away, and a confirm that is
// part of the page instead of `window.confirm()`. What is left here is what
// only this page can say: that a chip is a *shell*, and what closing one
// costs.
//
// The strip's id for a chip is the page's tab number rather than the session
// id, because a tab exists — and can be switched to, and closed — from the
// moment it is opened, which is before the helper has answered with a session
// to name it by.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { friendlyName, listBody, tokens } from "@fsio/ui";
import type { Chip, ChipAction, ConfirmCopy } from "@fsio/ui";
import { activeTabId, phase, resumable, tabs, type TabRecord } from "../state";
import { refreshResumable } from "../connection";
import { closeTab, detachTab, openTab, setActiveTab } from "../tabs";

class FsioTabBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    listBody,
    css`
      /* A pass-through: the strip does its own pushing, so this wrapper only
         has to get out of its way. */
      :host { display: flex; align-items: center; flex: 1; min-width: 0; }
      fsio-tab-strip { flex: 1; min-width: 0; }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const list = tabs.get();
    const connected = phase.get() === "shell" || phase.get() === "picker";
    if (!connected && !list.length) return nothing;
    return html`<fsio-tab-strip
      .chips=${list.map((t) => this.#chip(t))}
      .activeId=${activeTabId.get() === null ? null : String(activeTabId.get())}
      .confirmFor=${this.#confirmFor}
      .menuFor=${this.#menuFor}
      .showList=${connected}
      label="shells in this folder"
      listTitle="the shells in this folder"
      @select=${(e: CustomEvent<{ id: string }>) => setActiveTab(Number(e.detail.id))}
      @close=${(e: CustomEvent<{ id: string }>) => this.#withTab(e.detail.id, (t) => void closeTab(t))}
      @action=${this.#action}
      @list-open=${() => void refreshResumable()}
    >
      <div slot="list">${this.#list()}</div>
    </fsio-tab-strip>`;
  }

  #chip(t: TabRecord): Chip {
    const st = t.state.get();
    const name = t.title.get();
    return {
      id: String(t.tabId),
      name,
      dot: st === "starting" ? "busy" : st === "exited" ? "gone" : st === "superseded" ? "fenced" : st === "failed" ? "bad" : "",
      title: `${name}${t.sessionId ? ` (${t.sessionId})` : ""}`,
      dotTitle:
        st === "starting"
          ? "still starting"
          : st === "exited"
            ? "this shell has exited"
            : st === "superseded"
              ? "another window took this shell over"
              : st === "failed"
                ? "this shell failed to start"
                : "",
      closeTitle:
        st === "running" || st === "starting"
          ? "end this shell — the process stops"
          : "close this tab — the shell is already gone",
    };
  }

  /** What the "×" costs. A shell that has already exited, failed, or been
   *  taken over by another window costs nothing to close — there is no
   *  process left for this page to stop. A live one is the same irreversible
   *  gesture the agent demo asks about, so it asks here too. */
  #confirmFor = (chip: Chip): ConfirmCopy | null => {
    const t = this.#tab(chip.id);
    const st = t?.state.get();
    if (!t || (st !== "running" && st !== "starting")) return null;
    return {
      question: html`Close <strong>${chip.name}</strong>? The shell process is killed, and it does not come back.`,
      note: html`To keep it running and come back to it later, use “leave it
        running” instead — the shell stays in this folder and in the “+” list,
        scrollback and all.`,
      confirm: "Close it — stop the shell",
    };
  };

  /** The other gesture, named rather than guessed at. This used to be a
   *  "detach" button in the status bar, which put the two ways of being done
   *  with a tab in two different places — one on the chip, one along the
   *  bottom — and made walking away the harder of the two to find. */
  #menuFor = (chip: Chip): ChipAction[] => {
    const t = this.#tab(chip.id);
    if (!t || t.state.get() !== "running") return [];
    return [
      {
        id: "leave",
        name: "leave it running",
        note: "The shell keeps running with no tab attached. This page lets go, and it shows up under “+” — here or in any browser you open this folder in.",
        button: "Leave",
      },
      {
        id: "end",
        name: "end it",
        note: "Stops the shell for good. The session ends and the process is killed.",
        button: "End…",
        danger: true,
      },
    ];
  };

  #action = (e: CustomEvent<{ id: string; action: string }>): void => {
    if (e.detail.action === "leave") this.#withTab(e.detail.id, (t) => void detachTab(t));
  };

  #tab(id: string): TabRecord | undefined {
    return tabs.get().find((t) => String(t.tabId) === id);
  }

  #withTab(id: string, fn: (t: TabRecord) => void): void {
    const t = this.#tab(id);
    if (t) fn(t);
  }

  /** Every shell in this folder that no tab here is holding, plus the way to
   *  start another. The agent demo's version of this list has a second half —
   *  the conversations that have ended — because a transcript is a thing a
   *  folder keeps. A shell's scrollback is not: it goes with the process. */
  #list(): TemplateResult {
    const held = new Set(tabs.get().filter((t) => t.session).map((t) => t.sessionId));
    const rows = resumable.get().filter((r) => !held.has(r.id));
    return html`
      <h3>shells in this folder</h3>
      <p class="explain">
        Shells live in the helper, not in this page. Everything running here
        that no tab is holding is in this list — resume one and you get its
        scrollback with it.
      </p>
      ${rows.length
        ? rows.map(
            (r) => html`<fsio-session-row
              .name=${friendlyName(r.id)}
              .meta=${r.status?.detached
                ? "left running — no tab is holding it"
                : `held by ${r.client ?? "another client"}${r.origin ? ` at ${r.origin}` : ""}, so resuming takes it over`}
              .action=${"Resume"}
              @action=${() => { this.#shut(); openTab(r.id); }}
            ></fsio-session-row>`
          )
        : html`<p class="explain">Nothing else is running here.</p>`}
      <button class="primary wide" @click=${() => { this.#shut(); openTab(); }}>
        Start a new shell
      </button>
    `;
  }

  /** Acting on a row closes the list it was in — the answer to "what else is
   *  here" is on screen the moment you pick one. */
  #shut(): void {
    this.renderRoot.querySelector("fsio-tab-strip")?.dismiss();
  }
}

customElements.define("fsio-tab-bar", FsioTabBar);
