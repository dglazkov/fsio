// The conversation, including the part that is the whole point: a
// permission card.
//
// When the agent asks `session/request_permission`, the question arrives as
// a card here — with the tool it wants to run, the file it names, and the
// options the agent itself offered. The human answers in the page, next to
// the workspace pane that shows the file. Compare the terminal version of
// this moment: the agent draws a prompt inside a pty, the page cannot style
// it, cannot link it to the file, and cannot tell you what confines the
// process being authorized. That difference is R6, and it is why the
// structured half of #18 was the half worth building.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { agentFacts, entries, notice, queued, turn, type Entry, type PermissionEntry, type ToolEntry } from "../state";
import { cancelTurn, sendPrompt, unqueue } from "../connection";
import { renderMarkdown } from "../markdown";

class AcpChat extends SignalWatcher(LitElement) {
  static override styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; }
    .log { flex: 1; overflow-y: auto; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.7rem; }
    .entry { max-width: 52rem; line-height: 1.5; }
    .user {
      align-self: flex-end; background: #2e3440; border-radius: 10px 10px 2px 10px;
      padding: 0.5rem 0.8rem; white-space: pre-wrap; color: #eceff4;
    }
    /* A queued prompt is a user bubble that hasn't happened yet: same shape,
       dimmed, with a way out. It sits in the log rather than above the
       composer so its position says what it means — next in line. */
    .user.queued {
      opacity: 0.62; border: 1px dashed #4c566a; background: #23272f;
      display: flex; gap: 0.5rem; align-items: flex-start;
    }
    .user.queued .drop {
      background: none; border: none; color: #9aa5b8; padding: 0 0.15rem;
      font-size: 1rem; line-height: 1.2; cursor: pointer;
    }
    .user.queued .drop:hover { color: #ef8a95; background: none; }
    button.queue { border-color: #4c566a; color: #9aa5b8; }
    .thought { color: #7b8598; font-size: 0.9rem; }
    /* Markdown, rendered from a token tree by ../markdown.ts. Paragraphs
       keep their newlines (pre-wrap) because the parser keeps soft breaks:
       in chat, a newline means a newline. */
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md p { margin: 0.5rem 0; white-space: pre-wrap; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
      margin: 0.9rem 0 0.4rem; line-height: 1.3; font-weight: 600; color: #eceff4;
    }
    .md h1 { font-size: 1.25rem; } .md h2 { font-size: 1.12rem; } .md h3 { font-size: 1rem; }
    .md h4, .md h5, .md h6 { font-size: 0.95rem; color: #d8dee9; }
    .md ul, .md ol { margin: 0.5rem 0; padding-left: 1.4rem; }
    .md li { margin: 0.15rem 0; }
    .md blockquote {
      margin: 0.5rem 0; padding-left: 0.8rem; border-left: 2px solid #3b4252;
      color: #9aa5b8; white-space: pre-wrap;
    }
    .md hr { border: none; border-top: 1px solid #2c313c; margin: 0.9rem 0; }
    .md code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em;
      background: #14161a; border-radius: 4px; padding: 0.1em 0.32em;
    }
    .md pre.code {
      margin: 0.55rem 0; background: #14161a; border: 1px solid #22262e; border-radius: 8px;
      padding: 0.6rem 0.75rem; overflow-x: auto;
    }
    .md pre.code code { background: none; padding: 0; font-size: 0.85rem; line-height: 1.45; }
    .md a { color: #88c0d0; }
    .md strong { color: #eceff4; }
    /* The thought bubble carries both classes on one element, so these are
       descendant-free selectors (.thought strong, not .thought .md strong)
       — headings and bold inside a thought stay as quiet as the thought. */
    .thought strong, .thought h1, .thought h2, .thought h3 { color: inherit; font-size: inherit; }
    .note { color: #7b8598; font-size: 0.85rem; }
    .error { color: #ef8a95; white-space: pre-wrap; font-size: 0.9rem; }
    .tool {
      border-left: 2px solid #3b4252; padding: 0.1rem 0 0.1rem 0.7rem;
      font-size: 0.87rem; color: #9aa5b8;
    }
    .tool .title { color: #d8dee9; }
    .tool .status { font-size: 0.78rem; color: #7b8598; }
    .tool .status.completed { color: #a3be8c; }
    .tool .status.failed { color: #ef8a95; }
    .tool pre { margin: 0.25rem 0 0; white-space: pre-wrap; font-size: 0.8rem; color: #7b8598; max-height: 12rem; overflow: auto; }
    .perm {
      border: 1px solid #5e81ac; border-radius: 10px; padding: 0.7rem 0.9rem;
      background: #1b212b; max-width: 44rem;
    }
    .perm .who { font-size: 0.78rem; color: #88c0d0; text-transform: uppercase; letter-spacing: 0.04em; }
    .perm .title { color: #eceff4; font-weight: 600; margin: 0.2rem 0; }
    .perm .where { font-size: 0.82rem; color: #9aa5b8; font-family: ui-monospace, Menlo, monospace; }
    .perm pre { margin: 0.4rem 0 0; white-space: pre-wrap; font-size: 0.8rem; color: #9aa5b8; max-height: 12rem; overflow: auto; }
    .perm .wall { font-size: 0.78rem; color: #7b8598; margin-top: 0.5rem; }
    .perm .row { display: flex; gap: 0.5rem; margin-top: 0.7rem; flex-wrap: wrap; }
    .perm .answered { color: #a3be8c; font-size: 0.85rem; margin-top: 0.6rem; }
    button {
      background: #2e3440; color: #d8dee9; border: 1px solid #4c566a;
      border-radius: 6px; padding: 0.35rem 0.9rem; font: inherit; font-size: 0.88rem; cursor: pointer;
    }
    button:hover { background: #3b4252; }
    button.allow { background: #5e81ac; border-color: #5e81ac; color: #eceff4; font-weight: 600; }
    button.reject { border-color: #6b3b40; color: #e5a3a8; }
    .composer { display: flex; gap: 0.6rem; padding: 0.7rem 1.2rem 1rem; border-top: 1px solid #262b34; }
    textarea {
      flex: 1; resize: none; background: #191c22; color: #d8dee9; font: inherit;
      border: 1px solid #2c313c; border-radius: 8px; padding: 0.55rem 0.7rem; min-height: 2.6rem; max-height: 9rem;
    }
    textarea:focus { outline: none; border-color: #4c566a; }
    .banner { background: #2b1f22; border: 1px solid #6b3b40; color: #e5a3a8; border-radius: 8px; padding: 0.5rem 0.8rem; font-size: 0.87rem; }
    .banner .hint { color: #c98d92; display: block; font-size: 0.82rem; margin-top: 0.2rem; }
  `;

  override render(): TemplateResult {
    const n = notice.get();
    const t = turn.get();
    const q = queued.get();
    const busy = t === "thinking" || t === "cancelling";
    return html`
      <div class="log" id="log">
        ${n ? html`<div class="banner">${n.msg}<span class="hint">${n.hint}</span></div>` : nothing}
        ${entries.get().map((e) => this.#entry(e))}
        ${q.map(
          (text, i) => html`<div class="entry user queued">
            ${text}
            <button class="drop" title="don't send this" @click=${() => unqueue(i)}>×</button>
          </div>`
        )}
      </div>
      <div class="composer">
        <textarea
          id="input"
          placeholder=${t === "gone"
            ? "the agent is gone — “new session” up top starts another one"
            : busy
              ? "type ahead — this goes when the turn ends"
              : "ask the agent to do something in this folder…"}
          ?disabled=${t === "gone" || t === "starting"}
          @keydown=${this.#keydown}
        ></textarea>
        ${busy
          ? html`<button class="queue" @click=${() => this.#send()}>queue</button>
              <button @click=${() => cancelTurn()} ?disabled=${t === "cancelling"}>stop</button>`
          : html`<button class="allow" ?disabled=${t !== "idle"} @click=${() => this.#send()}>send</button>`}
      </div>
    `;
  }

  protected override updated(): void {
    const log = this.renderRoot.querySelector("#log");
    if (log) log.scrollTop = log.scrollHeight;
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
    return html`<div class="entry perm">
      <div class="who">the agent is asking${e.toolKind && e.toolKind !== "other" ? ` · ${e.toolKind}` : ""}</div>
      <div class="title">${e.title}</div>
      ${e.locations.length ? html`<div class="where">${e.locations.join(", ")}</div>` : nothing}
      ${e.detail ? html`<pre>${e.detail}</pre>` : nothing}
      ${facts
        ? html`<div class="wall">
            whatever you answer, ${facts.agent} is ${facts.sandboxed ? `confined — ${facts.confinement}` : "NOT confined: it can write anything you can"}
          </div>`
        : nothing}
      ${answered === null
        ? html`<div class="row">
            ${e.options.map(
              (o) => html`<button
                class=${o.kind?.startsWith("allow") ? "allow" : o.kind?.startsWith("reject") ? "reject" : ""}
                @click=${() => e.respond?.(o.optionId)}
              >${o.name}</button>`
            )}
            <button @click=${() => e.respond?.(null)}>cancel</button>
          </div>`
        : html`<div class="answered">answered: ${e.options.find((o) => o.optionId === answered)?.name ?? answered}</div>`}
    </div>`;
  }
}

customElements.define("acp-chat", AcpChat);
