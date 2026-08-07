// `<pewter-status>` — one quiet line above a screen: what just happened, and
// at most one thing to do about it.
//
// Extracted from the terminal and agent screens, which had each written
// exactly this line, its span, and its one button.
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { control, tokens } from "./tokens.js";

/** Two spellings of the same element, because screens come in two shapes.
 *
 *  A screen driven by signals binds the properties:
 *
 *      html`<pewter-status .text=${said.get()} .action=${offer.get()}
 *                          .onact=${() => again()}></pewter-status>`
 *
 *  A screen that runs imperatively calls the methods:
 *
 *      status.say("the shell ended — exit 0");
 *      status.offer("new shell", () => again());
 *
 *  The methods write the properties and nothing else, so the two cannot
 *  disagree — and a screen converted from one shape to the other keeps
 *  working while it is half done. */
export class PewterStatus extends LitElement {
  static override properties = {
    text: {},
    action: {},
  };

  /** What the line says. */
  text = "";
  /** The label on the one thing to do about it. Empty means no button. */
  action = "";
  /** What that button does. Not a reactive property: it is a function, it
   *  never arrives as an attribute, and nothing on screen changes when it
   *  changes. */
  onact: (() => void) | null = null;

  static override styles = [
    tokens,
    control,
    css`
      :host {
        display: block;
        padding: 0.5rem 1rem;
        font-size: 0.85rem;
        opacity: 0.75;
        white-space: pre-wrap;
      }
      /* The UA's own hidden rule is outranked by any author rule, and :host
         is an author rule — so an element that styles itself as a block box
         has to honour the attribute itself. It lives here, beside the
         display that breaks it, rather than as a guard rule in a stylesheet
         somebody may replace. */
      :host([hidden]) {
        display: none;
      }
      button {
        font-size: 0.8rem;
        margin-left: 0.6rem;
        padding: 0.1rem 0.6rem;
        border-radius: 5px;
        border: 1px solid var(--_line);
      }
    `,
  ];

  /** Show the line with these words. Clears any offer — a new line is a new
   *  state, and the button that belonged to the old one goes with it. */
  say(text: string): void {
    this.text = text;
    this.action = "";
    this.onact = null;
    this.hidden = false;
  }

  /** Put one action beside the words, without changing them. */
  offer(label: string, act: () => void): void {
    this.action = label;
    this.onact = act;
    this.hidden = false;
  }

  /** The line has nothing to say. */
  hide(): void {
    this.hidden = true;
  }

  override render(): TemplateResult {
    return html`<span part="said">${this.text}</span>${this.action
        ? html`<button part="button" @click=${this.#act}>${this.action}</button>`
        : nothing}`;
  }

  /** The button goes first, then the act — both screens this was extracted
   *  from hid it before doing anything else. */
  #act = (): void => {
    const act = this.onact;
    this.action = "";
    this.onact = null;
    act?.();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "pewter-status": PewterStatus;
  }
}
