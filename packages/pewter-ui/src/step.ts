// `<pewter-step>` — one thing being done, and how it is going.
//
// An agent's tool call is the case this was written for: a title, a state
// that changes under it, the files it touched, and a detail worth showing
// when there is one. None of that is about agents — a build step, a clone, a
// reading of a project are the same four facts — so it is a step rather than
// a tool call, and the agent screen is one caller.
//
// **The state is a word, not a spinner.** Four of them, and the element
// styles rather than animates: a row of spinners in a transcript is motion
// competing with the text somebody is reading, and a completed step should
// look finished rather than look like it stopped moving.
//
// **The detail is a slot**, for the reason `<pewter-ask>`'s body is: a diff
// wants a `<pre>`, a summary wants `<pewter-markdown>`, and an element that
// took a string would have to choose. Slotted content that is empty collapses
// on its own, so a screen can leave it out without a conditional.
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { paths as pathRow, pathStyles } from "./paths.js";
import { tokens } from "./tokens.js";

/** How a step is going. `waiting` is the honest state for something that has
 *  been described but has not started, which is what an agent reports before
 *  it has permission. */
export type PewterStepState = "waiting" | "running" | "done" | "failed";

export class PewterStep extends LitElement {
  static override properties = {
    label: {},
    state: { reflect: true },
    paths: { attribute: false },
  };

  /** What is being done, in the words of whatever is doing it. */
  label = "";
  state: PewterStepState = "waiting";
  /** Files this step is about. Clicking one calls `onpath`. */
  paths: string[] = [];

  /** Called with a path from `paths`; null leaves them as plain text. */
  onpath: ((path: string) => void) | null = null;

  static override styles = [
    tokens,
    pathStyles,
    css`
      :host {
        --_ok: var(--pewter-step-done, light-dark(#1c6b3f, #6fd39b));
        --_bad: var(--pewter-step-failed, light-dark(#a3372e, #ff8f85));
        --_busy: var(--pewter-step-running, light-dark(#2a5c9a, #86b7f0));
        display: block;
        font-size: 0.85rem;
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
      }
      .label {
        opacity: 0.9;
      }
      .state {
        font-size: 0.72rem;
        opacity: 0.7;
        white-space: nowrap;
      }
      :host([state="done"]) .state {
        color: var(--_ok);
      }
      :host([state="failed"]) .state {
        color: var(--_bad);
      }
      :host([state="running"]) .state {
        color: var(--_busy);
      }
      /* A step that failed is the one worth finding again in a long
         transcript, so it keeps an edge. */
      :host([state="failed"]) {
        border-inline-start: 2px solid var(--_bad);
        padding-inline-start: 0.5rem;
      }
      .detail {
        margin-top: 0.2rem;
      }
      ::slotted(pre) {
        margin: 0;
        padding: 0.4rem 0.55rem;
        border-radius: 6px;
        background: var(--_wash);
        font-size: 0.75rem;
        max-height: 14rem;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `,
  ];

  override render(): TemplateResult {
    return html`
      <div class="head">
        <span class="label" part="label">${this.label}</span>
        <span class="state" part="state">· ${this.state}</span>
      </div>
      ${pathRow(this.paths, this.onpath)}
      <div class="detail" part="detail"><slot></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pewter-step": PewterStep;
  }
}
