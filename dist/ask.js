// `<pewter-ask>` — a question with an answer somebody has to give.
//
// The shape an agent's `session/request_permission` takes on screen, and the
// reason the ACP demo says a page beats a terminal at this: an agent asking
// in a pty draws its own prompt, and nothing around it can style that, link
// it to the file it is about, or say what the process being authorized can
// reach. Here the question is markup, so all three are possible.
//
// Nothing in it is about agents. It is a heading, a body somebody slots in,
// the files the question concerns, and a row of choices — which is also a
// "delete this project?" confirm, or a "this clone will run install
// scripts" gate. `<pewter-menu>` is the neighbouring element and the split
// is worth knowing: a menu is a list you pick *from*, and this is a question
// you answer, with a body and with weight on the answers.
//
// **The body is a slot**, because the interesting part varies and the kit
// should not guess: a permission card wants a diff in a `<pre>`, a summary
// wants `<pewter-markdown>`, a delete confirm wants one sentence. Slotting it
// means the screen keeps its own markup rather than passing a string through
// an element that would have to decide how to render it.
//
// **The paths are a callback, not a link.** This package does not import
// `pewter` and must not: an element that called `pewt.open()` would make the
// kit depend on the API, and the kit is a look. So it reports which path was
// clicked and the screen decides what that means — which in a pewter is
// `pewt.open(path)` and a real tab.
import { LitElement, css, html, nothing } from "lit";
import { paths as pathRow, pathStyles } from "./paths.js";
import { control, tokens } from "./tokens.js";
export class PewterAsk extends LitElement {
    constructor() {
        super(...arguments);
        /** The question itself, in one line. */
        this.question = "";
        /** Who is asking, or what kind of thing this is — shown small, above.
         *  Empty is fine and common. */
        this.who = "";
        /** What can be answered. Empty renders no row, which is what an already
         *  answered or unanswerable question looks like. */
        this.choices = [];
        /** Files this question is about. Clicking one calls `onpath`. */
        this.paths = [];
        /** The value that was answered, or empty while it is still open. Setting
         *  it replaces the choices with what was chosen — the card stays on screen
         *  as a record rather than vanishing, because a transcript of questions
         *  with the answers removed is not a transcript. */
        this.answered = "";
        /** What to call the answer, when it is not one of `choices` — a cancel, or
         *  an answer read back from somewhere the options are not known. */
        this.answeredLabel = "";
        /** Called with the chosen value, or null when the question was dismissed.
         *  Not a reactive property: it is a function. */
        this.onpick = null;
        /** Called with a path from `paths`. Null means the paths are not
         *  clickable, which is the honest state when a screen has nowhere to open
         *  one. */
        this.onpath = null;
        /** Whether to offer a way out beside the agent's own options. An agent's
         *  question always has one — refusing to answer is an answer — and a
         *  screen's own confirm may not want it. */
        this.dismissable = false;
    }
    static { this.properties = {
        question: {},
        who: {},
        choices: { attribute: false },
        paths: { attribute: false },
        answered: {},
        answeredLabel: {},
    }; }
    static { this.styles = [
        tokens,
        control,
        pathStyles,
        css `
      :host {
        --_ask-edge: var(--pewter-ask-edge, var(--_line-strong));
        --_ask-bg: var(--pewter-ask-bg, var(--_wash));
        --_affirm: var(--pewter-ask-affirm, light-dark(#1c6b3f, #6fd39b));
        --_deny: var(--pewter-ask-deny, light-dark(#a3372e, #ff8f85));
        display: block;
        border: 1px solid var(--_ask-edge);
        border-radius: 10px;
        padding: 0.6rem 0.75rem;
        background: var(--_ask-bg);
      }
      .who {
        font-size: 0.75rem;
        opacity: 0.6;
        margin-bottom: 0.15rem;
      }
      .question {
        margin: 0 0 0.4rem;
        line-height: 1.4;
      }
      /* Whatever the screen slotted. Spaced from the question above and the
         answers below, and nothing else — its contents are not ours. */
      .body {
        margin: 0.4rem 0;
      }
      .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-top: 0.55rem;
      }
      .choices button {
        border: 1px solid var(--_line);
        border-radius: 7px;
        padding: 0.25rem 0.7rem;
        font-size: 0.85rem;
      }
      .choices button:hover:not(:disabled) {
        background: var(--_raised);
      }
      /* Weight, from what the answer means. An agent offering "allow once"
         and "reject" is offering two very different things, and a row of
         identical buttons makes the human do that reading themselves. */
      .choices button.affirm {
        color: var(--_affirm);
        border-color: currentColor;
      }
      .choices button.deny {
        color: var(--_deny);
      }
      .answered {
        margin-top: 0.5rem;
        font-size: 0.85rem;
        opacity: 0.75;
      }
      .answered b {
        font-weight: 600;
        opacity: 1;
      }
    `,
    ]; }
    render() {
        const chosen = this.answered
            ? (this.choices.find((c) => c.value === this.answered)?.label ?? this.answeredLabel ?? this.answered)
            : "";
        return html `
      ${this.who ? html `<div class="who" part="who">${this.who}</div>` : nothing}
      <p class="question" part="question">${this.question}</p>
      ${pathRow(this.paths, this.onpath)}
      <div class="body" part="body"><slot></slot></div>
      ${this.answered || this.answeredLabel
            ? html `<div class="answered" part="answered">answered: <b>${chosen || this.answeredLabel}</b></div>`
            : this.choices.length || this.dismissable
                ? html `<div class="choices" part="choices">
              ${this.choices.map((c) => html `<button
                  part="choice"
                  class=${c.intent ?? ""}
                  @click=${() => this.onpick?.(c.value)}
                >${c.label}</button>`)}
              ${this.dismissable ? html `<button part="choice" @click=${() => this.onpick?.(null)}>dismiss</button>` : nothing}
            </div>`
                : nothing}
    `;
    }
}
//# sourceMappingURL=ask.js.map