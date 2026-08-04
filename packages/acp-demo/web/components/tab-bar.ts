// What this page has open in this folder: N conversations, the files you went
// and looked at, and the list that finds the conversations this page isn't
// holding.
//
// The strip carries two kinds of chip now. That is a widening of what a chip
// means — it was a conversation, and this file's comments below still argue
// that at length — and the reason it survives the widening is that the two
// kinds share the sentence the strip actually makes: *this folder, and what is
// open in it*. A file chip is the quiet kind. It has no dot, no badge and no
// confirm, because a window onto a file has no state to be in and closing it
// costs nothing; it wears an icon so nobody has to read "notes.md" to know it
// is not an agent.
//
// The strip itself is `@fsio/ui`'s now — the chips, the keyboard, the
// popovers, the confirm — because the terminal demo had grown a poorer copy
// of the same thing and one of them had to win. What is left here is what
// only this page can say: that a chip is a *conversation*, what it costs to
// close one, and what the two halves of the "+" list are.
//
// Two things on a chip that a shell tab would not need, both because an agent
// is not a shell. The badge is the load-bearing one: this whole demo exists
// because the agent's consent question becomes page UI (#18), and a question
// asked in a background tab is that demo failing silently. `unread` is the
// quieter version of the same point — with one conversation the page WAS the
// notification.
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
import { friendlyName, listBody, sinceLabel, sizeOf, tokens } from "@fsio/ui";
import type { Chip, ChipAction, ConfirmCopy } from "@fsio/ui";
import { activeFile, activeId, convs, fileTabs, joinable, past, phase, type Adoptable, type Conv, type FileTab, type PastConversation } from "../state";
import { activate } from "../conversations";
import { basename, closeFile, isFileTab, showFile } from "../files";
import { adoptSession, currentRoot, endSession, leaveSession, refreshJoinable, startAnother } from "../connection";
import { openPast, refreshPast } from "../history";
import { isTail } from "../../src/transcripts.js";

class AcpTabBar extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    listBody,
    css`
      /* A pass-through: the strip does the pushing (its internal spacer is
         what keeps "+" beside the last chip instead of at the far right), so
         this wrapper only has to get out of its way. */
      :host { display: flex; align-items: center; flex: 1; min-width: 0; }
      fsio-tab-strip { flex: 1; min-width: 0; }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const list = convs.get();
    const open = fileTabs.get();
    // Before there is a folder there is nothing to have chips of. Reading a
    // past conversation used to be the other reason to hide — it took over
    // the whole pane, so a strip under it would have offered to switch to
    // something that was not on screen. A document is a chip now (#140), so
    // it is exactly what the strip is for.
    if (phase.get() !== "chat" && !list.length) return nothing;
    return html`<fsio-tab-strip
      .chips=${[...list.map((c) => this.#chip(c)), ...open.map((f) => this.#file(f))]}
      .activeId=${activeFile.get() ?? activeId.get()}
      .confirmFor=${this.#confirmFor}
      .menuFor=${this.#menuFor}
      label="conversations in this folder"
      listTitle="the conversations in this folder"
      @select=${(e: CustomEvent<{ id: string }>) => this.#select(e.detail.id)}
      @close=${(e: CustomEvent<{ id: string }>) =>
        isFileTab(e.detail.id) ? closeFile(e.detail.id) : void endSession(e.detail.id, true)}
      @action=${this.#action}
      @list-open=${this.#refreshList}
    >
      <div slot="list">${this.#list()}</div>
    </fsio-tab-strip>`;
  }

  /** A file this page has open, in the same strip as the conversations.
   *
   *  The strip is "what this page has open in this folder", and both kinds of
   *  thing are that. What keeps them apart is the icon and the absence of
   *  everything else a conversation chip carries: a file has no turn, nothing
   *  unread, nobody waiting on an answer, and no dot — because a dot is a
   *  state something is IN, and a file being open is not a state, it is a
   *  window. */
  #file(f: FileTab): Chip {
    return {
      id: f.id,
      name: basename(f.path),
      secondary: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "",
      icon: "draft",
      title: `${f.path} — read live from the folder you granted`,
      closeTitle: "close this window — the file is untouched",
    };
  }

  /** Files and conversations answer the same click differently, and this
   *  two-line split is the whole of what a mixed strip costs. Coming back to a
   *  conversation puts the file view away — `activate` does that, for every
   *  route to a conversation and not just this one. */
  #select(id: string): void {
    if (isFileTab(id)) return showFile(id);
    activate(id);
  }

  #chip(c: Conv): Chip {
    const t = c.turn.get();
    const fenced = !!c.superseded.get();
    const doc = !!c.doc;
    const name = friendlyName(c.id);
    const agent = c.title.get();
    return {
      id: c.id,
      name,
      // The agent's name is a different fact from the conversation's — three
      // chips can say "claude" — so it is the quiet one, and the first to go
      // when the bar is tight.
      secondary: doc ? `${agent} · read-only` : agent,
      dot: doc
        ? "doc"
        : fenced
          ? "fenced"
          : t === "thinking" || t === "starting"
            ? "busy"
            : t === "gone"
              ? "gone"
              : c.unread.get()
                ? "unread"
                : "",
      badge: c.asking.get(),
      title: doc
        ? `${name} · ${agent} — a conversation that ended, read-only (${c.id})`
        : fenced
          ? `${name} · ${agent} — another window is driving this one (${c.id})`
          : `${name} · ${agent} (${c.id})`,
      dotTitle: doc
        ? "this conversation is over — what you are reading is the transcript"
        : fenced
          ? "another window took this conversation over"
          : t === "gone"
            ? "this agent has stopped"
            : c.unread.get()
              ? "it has said things you have not read"
              : "",
      closeTitle: doc
        ? "put this transcript away — it stays in the folder"
        : t === "gone"
          ? "close this tab — the agent has already stopped"
          : "end this conversation — the agent stops",
      quiet: doc,
    };
  }

  /** What the "×" costs. A document costs nothing — the transcript is in the
   *  folder and "+" lists it — and neither does a conversation whose agent has
   *  already exited, so both close on the click. Everything else stops an
   *  agent, which is the one gesture on this page that does not come back. */
  #confirmFor = (chip: Chip): ConfirmCopy | null => {
    const c = convs.get().find((x) => x.id === chip.id);
    if (!c || c.doc || c.turn.get() === "gone") return null;
    const agent = c.title.get() || "the agent";
    return {
      question: html`Close <strong>${chip.name}</strong>? ${agent} stops, and it does not come back.`,
      note: html`To keep it running and come back to it later, use “leave it
        running” instead — it stays in this folder and in the “+” list. What was
        said here is kept either way: it moves to the ended half of that same
        list.`,
      confirm: `Close it — stop ${agent}`,
    };
  };

  /** The other gesture, named rather than guessed at. Both meanings of "I am
   *  done with this tab" are real, and a single button that picked one would
   *  be wrong half the time. */
  #menuFor = (chip: Chip): ChipAction[] => {
    const c = convs.get().find((x) => x.id === chip.id);
    if (!c || c.doc || c.turn.get() === "gone") return [];
    return [
      {
        id: "leave",
        name: "leave it running",
        note: "The agent keeps working. This page stops holding it, and it shows up under “+” — here or in any browser you open this folder in.",
        button: "Leave",
      },
      {
        id: "end",
        name: "end it",
        note: "Stops the agent for good. What it said stays readable in the “+” list, under the conversations that have ended.",
        button: "End…",
        danger: true,
      },
    ];
  };

  #action = (e: CustomEvent<{ id: string; action: string }>): void => {
    if (e.detail.action === "leave") void leaveSession(e.detail.id);
  };

  #refreshList = (): void => {
    void refreshJoinable();
    const root = currentRoot();
    if (root) void refreshPast(root).catch(() => {});
  };

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
    return html`
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
      <button class="primary wide" @click=${() => { this.#shut(); void startAnother(); }}>
        Start a new conversation
      </button>
    `;
  }

  #running(r: Adoptable): TemplateResult {
    return html`<fsio-session-row
      .name=${friendlyName(r.id)}
      .meta=${`${r.agentName || r.agent || "an agent"} · ${sinceLabel(r.startedAt, Date.now())} · ${
        r.detached ? "left running — no page is holding it" : `held by ${r.client || "another page"}, so joining takes it over`
      }`}
      .quote=${r.lastLine ?? ""}
      .flag=${r.blocked ?? ""}
      .action=${r.blocked ? "" : "Join"}
      @action=${() => { this.#shut(); void adoptSession(r.id); }}
    ></fsio-session-row>`;
  }

  /** An ended one. Read-only, and the agent's half only: prompts rode the
   *  uplink, which is not what the folder keeps (#119, D26 rule 4). It keeps
   *  the name it had while it was running, because the transcript keeps the
   *  session's id. */
  #ended(p: PastConversation, root: FileSystemDirectoryHandle | null): TemplateResult {
    return html`<fsio-session-row
      .name=${friendlyName(p.id)}
      .meta=${`${p.agent || p.kind || "session"} · ${p.ended ? new Date(p.ended).toLocaleString() : "ended"}${
        p.why ? ` · ${p.why}` : ""
      } · ${sizeOf(p.bytes)}${isTail(p) ? " · tail only" : ""}`}
      .action=${"Read"}
      .hint=${"the agent's half, replayed from what the helper kept"}
      ?disabled=${!root}
      @action=${() => { this.#shut(); if (root) void openPast(root, p); }}
    ></fsio-session-row>`;
  }

  /** Acting on a row closes the list it was in — the answer to "what else is
   *  here" is on screen the moment you pick one. */
  #shut(): void {
    this.renderRoot.querySelector("fsio-tab-strip")?.dismiss();
  }
}

customElements.define("acp-tab-bar", AcpTabBar);
