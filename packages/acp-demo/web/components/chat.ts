// The conversation, including the part that is the whole point: a
// permission card.
//
// When the agent asks `session/request_permission`, the question arrives as
// a card here — with the tool it wants to run, the file it names, and the
// options the agent itself offered. The human answers in the page, next to
// the workspace pane that shows the file. Compare the terminal version of
// this moment: the agent draws a prompt inside a pty, the page cannot style
// it, cannot link it to the file, and cannot tell you what confines the
// process being authorized. That difference is the demo's whole point, and
// it is why the
// structured half of #18 was the half worth building.
import { LitElement, html, css, nothing } from "lit";
import { controls, icons, tokens } from "@fsio/ui";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { active, agentFacts, asking, convs, entries, notice, phase, queued, superseded, turn, viewing, viewingHalf, type Entry, type PermissionEntry, type ToolEntry } from "../state";
import { cancelTurn, sendPrompt, unqueue } from "../conversations";
import { endSession, retakeSession, startAnother } from "../connection";
import { renderMarkdown } from "../markdown";

/** What the page says while it waits. None of them is a claim about what the
 *  agent is doing — the page cannot know that, and an honest-looking one
 *  ("reading your files") would be a guess dressed as a fact. They are all
 *  synonyms for "still going". */
const WORDS = [
  "thinking", "pondering", "mulling", "puzzling", "noodling", "ruminating",
  "considering", "deliberating", "percolating", "chewing on it", "turning it over",
];

class AcpChat extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    controls,
    icons,
    css`
    :host { display: flex; flex-direction: column; min-height: 0; }
    .log { flex: 1; overflow-y: auto; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.7rem; }
    .entry { max-width: 52rem; line-height: 1.5; }
    /* The one bubble on the page. It needs a border now that it sits on wood
       rather than on a flat dark field — a fill alone stopped being an edge
       the moment the background gained texture. */
    .user {
      align-self: flex-end; background: var(--fsio-control);
      border: 1px solid var(--fsio-line); box-shadow: var(--fsio-lift);
      border-radius: 12px 12px 3px 12px;
      padding: 0.5rem 0.8rem; white-space: pre-wrap; color: var(--fsio-fg-bright);
    }
    /* A queued prompt is a user bubble that hasn't happened yet: same shape,
       dimmed, with a way out. It sits in the log rather than above the
       composer so its position says what it means — next in line. */
    .user.queued {
      opacity: 0.62; border: 1px dashed var(--fsio-line-control); background: var(--fsio-aside);
      box-shadow: none;
      display: flex; gap: 0.5rem; align-items: flex-start;
    }
    .user.queued .drop {
      background: none; border: none; box-shadow: none; backdrop-filter: none;
      color: var(--fsio-dim); padding: 0 0.15rem;
      line-height: 1.2; cursor: pointer;
    }
    .user.queued .drop:hover { color: var(--fsio-bad-bright); background: none; }
    button.queue { border-color: var(--fsio-line-control); color: var(--fsio-dim); }
    .thought { color: var(--fsio-dimmer); font-size: 0.9rem; }
    /* The turn, where the turn is happening. It used to be a word in the top
       bar, which is where a page says things about itself — but "it is
       thinking" is the newest thing in the conversation, not a property of
       the page, and with N conversations the top bar was saying it about
       whichever one you happened to be looking at. So it is the last row of
       the log, and it goes away when the turn ends. */
    .working { display: flex; align-items: center; gap: 0.5rem; color: var(--fsio-dimmer); font-size: 0.9rem; }
    .working .pulse {
      width: 7px; height: 7px; border-radius: 50%; background: var(--fsio-cyan); flex: none;
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .working .pulse { animation: none; opacity: 0.8; } }
    .working .secs { color: var(--fsio-dimmest); font-size: 0.82rem; font-variant-numeric: tabular-nums; }
    /* Blocked on the human. The same blue the permission card and the chip's
       badge use, because it is the same fact in its third place — and steady
       rather than pulsing, since nothing is happening until you act. */
    .working.yours { color: var(--fsio-cyan); }
    .working.yours .pulse { background: var(--fsio-accent); animation: none; }
    /* Markdown, rendered from a token tree by ../markdown.ts. Paragraphs
       keep their newlines (pre-wrap) because the parser keeps soft breaks:
       in chat, a newline means a newline. */
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md p { margin: 0.5rem 0; white-space: pre-wrap; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
      margin: 0.9rem 0 0.4rem; line-height: 1.3; font-weight: 600; color: var(--fsio-fg-bright);
    }
    .md h1 { font-size: 1.25rem; } .md h2 { font-size: 1.12rem; } .md h3 { font-size: 1rem; }
    .md h4, .md h5, .md h6 { font-size: 0.95rem; color: var(--fsio-fg); }
    .md ul, .md ol { margin: 0.5rem 0; padding-left: 1.4rem; }
    .md li { margin: 0.15rem 0; }
    .md blockquote {
      margin: 0.5rem 0; padding-left: 0.8rem; border-left: 2px solid var(--fsio-line-strong);
      color: var(--fsio-dim); white-space: pre-wrap;
    }
    .md hr { border: none; border-top: 1px solid var(--fsio-line); margin: 0.9rem 0; }
    .md code {
      font-family: var(--fsio-mono); font-size: 0.88em;
      background: var(--fsio-bg); border-radius: 4px; padding: 0.1em 0.32em;
    }
    .md pre.code {
      margin: 0.55rem 0; background: var(--fsio-bg); border: 1px solid var(--fsio-line); border-radius: 8px;
      padding: 0.6rem 0.75rem; overflow-x: auto;
    }
    .md pre.code code { background: none; padding: 0; font-size: 0.85rem; line-height: 1.45; }
    .md a { color: var(--fsio-accent); }
    .md strong { color: var(--fsio-fg-bright); }
    /* The thought bubble carries both classes on one element, so these are
       descendant-free selectors (.thought strong, not .thought .md strong)
       — headings and bold inside a thought stay as quiet as the thought. */
    .thought strong, .thought h1, .thought h2, .thought h3 { color: inherit; font-size: inherit; }
    .note { color: var(--fsio-dimmer); font-size: 0.85rem; }
    .error { color: var(--fsio-bad-bright); white-space: pre-wrap; font-size: 0.9rem; }
    .tool {
      border-left: 2px solid var(--fsio-line-strong); padding: 0.1rem 0 0.1rem 0.7rem;
      font-size: 0.87rem; color: var(--fsio-dim);
    }
    .tool .title { color: var(--fsio-fg); }
    .tool .status { font-size: 0.78rem; color: var(--fsio-dimmer); }
    .tool .status.completed { color: var(--fsio-good); }
    .tool .status.failed { color: var(--fsio-bad); }
    .tool pre { margin: 0.25rem 0 0; white-space: pre-wrap; font-size: 0.8rem; color: var(--fsio-dimmer); max-height: 12rem; overflow: auto; }
    .perm {
      border: 1px solid var(--fsio-accent); border-radius: 12px; padding: 0.7rem 0.9rem;
      background: var(--fsio-raised); box-shadow: var(--fsio-lift); max-width: 44rem;
    }
    .perm .who { font-size: 0.78rem; color: var(--fsio-cyan); text-transform: uppercase; letter-spacing: 0.04em; }
    .perm .title { color: var(--fsio-fg-bright); font-weight: 600; margin: 0.2rem 0; }
    .perm .where { font-size: 0.82rem; color: var(--fsio-dim); font-family: var(--fsio-mono); }
    .perm pre { margin: 0.4rem 0 0; white-space: pre-wrap; font-size: 0.8rem; color: var(--fsio-dim); max-height: 12rem; overflow: auto; }
    .perm .wall { font-size: 0.78rem; color: var(--fsio-dimmer); margin-top: 0.5rem; }
    .perm .row { display: flex; gap: 0.5rem; margin-top: 0.7rem; flex-wrap: wrap; }
    .perm .answered { color: var(--fsio-good); font-size: 0.85rem; margin-top: 0.6rem; }
    /* Buttons come from the shared controls rule set above — the four
       variants and what they mean live in one place now. Only the size is
       this component's: a chat is dense, and a permission card carries three
       of them in a row. */
    button { padding: 0.35rem 0.9rem; font-size: 0.88rem; }
    .composer { display: flex; gap: 0.6rem; padding: 0.7rem 1.2rem 1rem; border-top: 1px solid var(--fsio-line); }
    /* Fenced (D18): the composer is replaced, not disabled — a text box with
       nothing on the other end of it is the wrong kind of hopeful. Amber
       rather than red: nothing is broken, somebody else is driving. */
    .composer.fenced { align-items: center; background: var(--fsio-warn-wash); border-top-color: var(--fsio-warn-line); }
    .composer.fenced .what { flex: 1; font-size: 0.87rem; color: var(--fsio-warn); }
    .composer.fenced .hint { display: block; color: var(--fsio-dim); font-size: 0.82rem; margin-top: 0.25rem; }
    .composer.fenced button { flex: none; }
    /* A document (#140). The same slot and the same shape as the fenced
       banner, quieter: fenced is a situation you can act on, and this is
       simply what the conversation is. */
    .composer.over { align-items: center; background: var(--fsio-aside); }
    .composer.over .what { flex: 1; font-size: 0.87rem; color: var(--fsio-dim); }
    .composer.over .hint { display: block; color: var(--fsio-dimmer); font-size: 0.82rem; margin-top: 0.25rem; }
    .composer.over button { flex: none; }
    textarea {
      flex: 1; resize: none; background: var(--fsio-raised); color: var(--fsio-fg);
      font: inherit; font-family: var(--fsio-sans);
      border: 1px solid var(--fsio-line-strong); border-radius: 9px; padding: 0.55rem 0.7rem; min-height: 2.6rem; max-height: 9rem;
    }
    textarea:focus { outline: none; border-color: var(--fsio-accent); }
    .banner { background: var(--fsio-bad-wash); border: 1px solid var(--fsio-bad-line); color: var(--fsio-bad-bright); border-radius: 9px; padding: 0.5rem 0.8rem; font-size: 0.87rem; }
    .banner .hint { color: var(--fsio-bad); display: block; font-size: 0.82rem; margin-top: 0.2rem; }
    /* The read-only header (#119): quiet, not alarming — nothing is wrong,
       this is simply a document. */
    .reading {
      background: var(--fsio-aside); border: 1px solid var(--fsio-line); color: var(--fsio-dim);
      border-radius: 9px; padding: 0.6rem 0.8rem; font-size: 0.87rem;
    }
    .reading .hint { color: var(--fsio-dimmer); display: block; font-size: 0.82rem; margin-top: 0.25rem; }
    .reading .close { margin-top: 0.5rem; font-size: 0.82rem; padding: 0.2rem 0.6rem; }
    .perm.historic { border-color: var(--fsio-line); background: var(--fsio-aside); box-shadow: none; }
    .perm.historic .who { color: var(--fsio-dimmer); }
    .perm.historic .opts { color: var(--fsio-dimmer); font-size: 0.82rem; margin-top: 0.55rem; }
    .opts { color: var(--fsio-dimmer); font-size: 0.82rem; margin-top: 0.55rem; }
    .opts code { font-family: var(--fsio-mono); color: var(--fsio-dim); }
  `,
  ];

  override render(): TemplateResult {
    const n = notice.get();
    const t = turn.get();
    const q = queued.get();
    const busy = t === "thinking" || t === "cancelling";
    const v = viewing.get();
    // A document, not a session (#119). No composer at all rather than a
    // disabled one: there is nothing on the other end of it, and a text box
    // that looks like it might send is the wrong kind of hopeful.
    //
    // What replaces it says so, from the composer's own slot — the same place
    // the fenced banner speaks from, for the same reason (#140). That slot is
    // where the page says what you can do here; at the top of the log this
    // was a caption on the transcript instead, which made a document a
    // different shape of page rather than the same page with the input
    // turned off.
    if (v) {
      const half = viewingHalf.get();
      return html`
        <div class="log" id="log">${entries.get().map((e) => this.#entry(e))}</div>
        <div class="composer over">
          <div class="what">
            reading a conversation that ended${v.ended ? ` on ${new Date(v.ended).toLocaleString()}` : ""}${v.agent ? ` · ${v.agent}` : ""}
            <!-- A line only when there is something to explain. A transcript
                 with your turns in it, in the right places, looks like a
                 conversation because it is one — the reader has no symptom,
                 and where the missing half went is the page's business, not
                 theirs. The two cases that DO show: prompts absent from
                 between the agent's messages, and prompts sitting in the
                 wrong places. If you later open this folder somewhere else,
                 that browser lands in the first case and says so itself, at
                 the moment it is true. -->
            ${!half
              ? html`<span class="hint">Your own turns are not here — the folder keeps only the agent's half.</span>`
              : half.placed
                ? nothing
                : html`<span class="hint">Your turns are all here, but not necessarily in the places you typed them.</span>`}
          </div>
          <button @click=${() => void endSession(v.id, true)}>close</button>
        </div>
      `;
    }
    // Every conversation closed (#120). Not the wizard — the folder is still
    // granted, the helper is still running, and the page has not forgotten
    // anything. It is simply holding none of the conversations in this
    // folder, which is a state that could not exist when there was only ever
    // one of them.
    if (!active.get() && phase.get() === "chat") {
      return html`<div class="log" id="log">
        ${n ? html`<div class="banner">${n.msg}<span class="hint">${n.hint}</span></div>` : nothing}
        <div class="reading">
          no conversation open
          <span class="hint">
            ${convs.get().length
              ? "Pick one from the strip above."
              : "Start a conversation in this folder, or open “+” above — it lists every conversation this folder knows about, the ones still running and the ones that have ended."}
          </span>
          <button class="close" @click=${() => void startAnother()}>Start a conversation</button>
        </div>
      </div>`;
    }
    return html`
      <div class="log" id="log">
        ${n ? html`<div class="banner">${n.msg}<span class="hint">${n.hint}</span></div>` : nothing}
        ${entries.get().map((e) => this.#entry(e))}
        ${this.#working(t)}
        ${q.map(
          (text, i) => html`<div class="entry user queued">
            ${text}
            <button class="drop" title="don't send this" @click=${() => unqueue(i)}><span class="icon sm">close</span></button>
          </div>`
        )}
      </div>
      ${superseded.get() ? this.#fenced() : this.#composer(t, busy)}
    `;
  }

  /** Another window is driving this conversation (D18 takeover).
   *
   *  The composer is replaced rather than disabled, for the same reason the
   *  read-only view has no composer at all: there is nothing on the other end
   *  of it. What is different here — and worth saying plainly, because it is
   *  the part a reader would otherwise mistake for the agent losing its mind
   *  — is that the transcript keeps growing with only one half of the
   *  conversation in it. */
  #fenced(): TemplateResult {
    const c = active.get();
    return html`<div class="composer fenced">
      <div class="what">
        another window is driving this conversation
        <span class="hint">
          Attaching takes over, so exactly one page holds an agent at a time (D18). You are still watching it live — the
          agent's half rides the folder and every page can read it — but the prompts driving it are being typed somewhere
          else, and those ride the uplink, which only the holder writes. Expect answers without their questions.
        </span>
      </div>
      <button class="primary" ?disabled=${!c} @click=${() => c && void retakeSession(c.id)}>take it back</button>
    </div>`;
  }

  #composer(t: ReturnType<typeof turn.get>, busy: boolean): TemplateResult {
    return html`
      <div class="composer">
        <textarea
          id="input"
          placeholder=${t === "gone"
            ? "the agent is gone — “+” in the strip above starts another one"
            : busy
              ? "type ahead — this goes when the turn ends"
              : "ask the agent to do something in this folder…"}
          ?disabled=${t === "gone" || t === "starting"}
          @keydown=${this.#keydown}
        ></textarea>
        ${busy
          ? html`<button class="queue" @click=${() => this.#send()}>queue</button>
              <button @click=${() => cancelTurn()} ?disabled=${t === "cancelling"}>stop</button>`
          : html`<button class="primary" ?disabled=${t !== "idle"} @click=${() => this.#send()}>send</button>`}
      </div>
    `;
  }

  /** The rotating word, the seconds, and which conversation they belong to.
   *  Keyed by conversation because switching chips mid-turn must not hand
   *  the new one the old one's stopwatch. */
  #tick: ReturnType<typeof setInterval> | undefined;
  #ticks = 0;
  #since = 0;
  #word = 0;
  #workingOn = "";

  /** The last row of the log while the agent works, and gone the moment it
   *  stops (the shape a CLI has trained everyone on). The word rotates every
   *  four seconds — it says nothing the elapsed count does not, and that is
   *  the point: it is the part of the row that proves the page is still
   *  running rather than frozen. */
  #working(t: ReturnType<typeof turn.get>): TemplateResult | typeof nothing {
    if (t === "starting") return this.#row("starting the agent", null);
    if (t === "cancelling") return this.#row("stopping", null);
    if (t !== "thinking") return nothing;
    // The ticker starts in updated(), which is one frame behind this — so the
    // first frame of a turn has no stopwatch yet, and says 0 rather than the
    // seconds since 1970.
    const secs = this.#since ? Math.floor((Date.now() - this.#since) / 1000) : 0;
    // The turn is in flight either way, but it is not the same wait, and a
    // rotating "pondering…" over a card the agent is blocked on is the page
    // lying about who is holding things up. That distinction is this demo's
    // subject (#18), so the row says which of the two it is.
    const n = asking.get();
    if (!n) return this.#row(WORDS[this.#word % WORDS.length]!, secs, false);
    if (superseded.get()) return this.#row("waiting for an answer in the window driving this conversation", secs, true);
    return this.#row(n === 1 ? "waiting for your answer" : `waiting for your ${n} answers`, secs, true);
  }

  /** `yours` swaps the pulse for a steady dot: the agent working is something
   *  happening, and the agent waiting on you is not. */
  #row(word: string, secs: number | null, yours = false): TemplateResult {
    return html`<div class="entry working ${yours ? "yours" : ""}">
      <span class="pulse"></span>
      <span>${word}${yours ? "" : "…"}</span>
      ${secs === null ? nothing : html`<span class="secs">${secs}s</span>`}
    </div>`;
  }

  /** One interval while a turn is in flight, none otherwise. Restarted when
   *  the conversation on screen changes, which is also what resets the count
   *  and picks a new word to start from. */
  #syncTicker(): void {
    const key = !viewing.get() && turn.get() === "thinking" ? (active.get()?.id ?? "") : "";
    if (key === this.#workingOn) return;
    this.#workingOn = key;
    clearInterval(this.#tick);
    this.#tick = undefined;
    if (!key) return;
    this.#since = Date.now();
    this.#ticks = 0;
    this.#word = Math.floor(Math.random() * WORDS.length);
    this.#tick = setInterval(() => {
      if (++this.#ticks % 4 === 0) this.#word++;
      this.requestUpdate();
    }, 1000);
  }

  override disconnectedCallback(): void {
    clearInterval(this.#tick);
    this.#tick = undefined;
    this.#workingOn = "";
    super.disconnectedCallback();
  }

  /** Which document the reader has already been placed in, so re-renders
   *  don't yank them back to the top of it. */
  #placedIn: string | null = null;

  protected override updated(): void {
    this.#syncTicker();
    const log = this.renderRoot.querySelector("#log");
    if (!log) return;
    const v = viewing.get();
    // A live conversation follows the agent; a document is read from the
    // beginning. Dropping someone at the end of a conversation they are
    // opening to re-read would be the wrong end of it.
    if (v) {
      if (this.#placedIn !== v.id) {
        this.#placedIn = v.id;
        log.scrollTop = 0;
      }
      return;
    }
    this.#placedIn = null;
    log.scrollTop = log.scrollHeight;
  }

  #keydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.#send();
    }
  }

  #send(): void {
    const ta = this.renderRoot.querySelector("#input") as HTMLTextAreaElement | null;
    const text = ta?.value.trim();
    if (!ta || !text) return;
    ta.value = "";
    sendPrompt(text);
  }

  #entry(e: Entry): TemplateResult {
    switch (e.kind) {
      case "user":
        return html`<div class="entry user">${e.text}</div>`;
      case "agent":
        return html`<div class="entry agent md">${renderMarkdown(e.text.get())}</div>`;
      case "thought":
        return html`<div class="entry thought md">${renderMarkdown(e.text.get())}</div>`;
      case "note":
        return html`<div class="entry note">${e.text}</div>`;
      case "error":
        return html`<div class="entry error">${e.text}</div>`;
      case "tool":
        return this.#tool(e);
      case "permission":
        return this.#permission(e);
    }
  }

  #tool(e: ToolEntry): TemplateResult {
    const detail = e.detail.get();
    return html`<div class="entry tool">
      <span class="title">${e.title.get()}</span>
      <span class="status ${e.status.get()}">· ${e.status.get()}</span>
      ${e.locations.get().length ? html`<div class="where">${e.locations.get().join(", ")}</div>` : nothing}
      ${detail ? html`<pre>${detail}</pre>` : nothing}
    </div>`;
  }

  #permission(e: PermissionEntry): TemplateResult {
    const answered = e.answer.get();
    const facts = agentFacts.get();
    // Out of a transcript (#119, #123): the question was in the folder, the
    // answer never was. Whether the verdict can be shown depends on who is
    // reading — this browser kept what it clicked, another one cannot know
    // and is told so. Either way there are no buttons: they would be a lie
    // twice over, since there is nobody left to answer to.
    if (e.historic)
      return html`<div class="entry perm historic">
        <div class="who">the agent asked${e.toolKind && e.toolKind !== "other" ? ` · ${e.toolKind}` : ""}</div>
        <div class="title">${e.title}</div>
        ${e.locations.length ? html`<div class="where">${e.locations.join(", ")}</div>` : nothing}
        ${e.detail ? html`<pre>${e.detail}</pre>` : nothing}
        ${answered === null
          ? html`<div class="opts">
              offered: ${e.options.map((o) => html`<code>${o.name}</code> `)}— what was answered is not recorded anywhere this
              page can see.
            </div>`
          : html`<div class="answered">answered: ${e.options.find((o) => o.optionId === answered)?.name ?? answered}</div>`}
      </div>`;
    return html`<div class="entry perm">
      <div class="who">the agent is asking${e.toolKind && e.toolKind !== "other" ? ` · ${e.toolKind}` : ""}</div>
      <div class="title">${e.title}</div>
      ${e.locations.length ? html`<div class="where">${e.locations.join(", ")}</div>` : nothing}
      ${e.detail ? html`<pre>${e.detail}</pre>` : nothing}
      ${answered !== null
        ? html`<div class="answered">answered: ${e.options.find((o) => o.optionId === answered)?.name ?? answered}</div>`
        : superseded.get()
          ? // Fenced (D18): the agent is genuinely blocked on this question,
            // and the answer has to come from whichever window holds the
            // uplink — this one's response would not go out. Buttons here
            // would be the worst kind of wrong: they look like the consent
            // gesture this whole demo is about, and they would do nothing.
            //
            // What is NOT said here is why (#140 question 8): the banner that
            // replaced the composer is saying it, a few hundred pixels down
            // and once, and it is the half with the button. This card's job
            // is the half only it knows — which question is the one blocked.
            html`<div class="opts">
              waiting on ${e.options.map((o) => html`<code>${o.name}</code> `)}— answering belongs to the window driving this
              conversation, below.
            </div>`
          : html`<div class="row">
              ${e.options.map(
                (o) => html`<button
                  class=${o.kind?.startsWith("allow") ? "allow" : o.kind?.startsWith("reject") ? "reject" : ""}
                  @click=${() => e.respond?.(o.optionId)}
                >${o.name}</button>`
              )}
              <button @click=${() => e.respond?.(null)}>cancel</button>
            </div>`}
    </div>`;
  }
}

customElements.define("acp-chat", AcpChat);
