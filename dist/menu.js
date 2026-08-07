// `<pewter-menu>` — a list of choices, each row one full-width button.
//
// Extracted from the terminal and agent pickers, which had each written this
// list, its rows, and its refresh.
import { LitElement, css, html } from "lit";
import { control, tokens } from "./tokens.js";
/** The list.
 *
 *      html`<pewter-menu .choices=${places.get()}
 *                        .onpick=${(v) => open(v)}></pewter-menu>`
 *
 *  or, imperatively:
 *
 *      menu.choices = [{ value: null, label: "this pewter" }, ...names];
 *      menu.onpick = (value) => open(value);
 *
 *  Setting `hints` instead replaces the list with plain rows — for when there
 *  is nothing to pick and the useful thing is to say why, which is the agent
 *  screen's empty roster. The two are exclusive: setting either clears the
 *  other, so a screen that offered hints once and can offer real choices the
 *  next time round does not have to remember to empty the first. */
export class PewterMenu extends LitElement {
    constructor() {
        super(...arguments);
        this.#choices = [];
        this.#hints = [];
        /** Called with the picked row's value. One handler, not a bus: the screens
         *  this serves route every pick the same place, and a property binds in a
         *  template as readily as an event listener would. */
        this.onpick = null;
    }
    #choices;
    #hints;
    static { this.styles = [
        tokens,
        control,
        css `
      :host {
        display: block;
      }
      :host([hidden]) {
        display: none;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        border-bottom: 1px solid var(--_hairline);
      }
      /* A row that is not a choice: nothing to pick, and this line says why. */
      li.hint {
        padding: 0.6rem 0.2rem;
        font-size: 0.85rem;
        opacity: 0.8;
        border-bottom: none;
      }
      button {
        display: block;
        width: 100%;
        text-align: left;
        padding: 0.6rem 0.2rem;
        border: none;
        border-radius: 0;
      }
      button:hover {
        background: var(--_wash);
      }
    `,
    ]; }
    /** Reactive by hand rather than through `static properties`, because
     *  setting either of these has to clear the other — and an accessor lit
     *  generated would have nowhere to put that. `requestUpdate()` is the whole
     *  contract a property has to keep. */
    get choices() {
        return this.#choices;
    }
    set choices(rows) {
        this.#choices = rows;
        this.#hints = [];
        this.requestUpdate();
    }
    /** Plain rows in place of the choices: there is nothing to pick, and these
     *  lines say why. */
    get hints() {
        return this.#hints;
    }
    set hints(lines) {
        this.#hints = lines;
        this.#choices = [];
        this.requestUpdate();
    }
    render() {
        return html `<ul part="list">
      ${this.#hints.map((line) => html `<li class="hint" part="hint">${line}</li>`)}
      ${this.#choices.map((row) => html `<li part="row">
            <button part="button" @click=${() => this.onpick?.(row.value)}>${row.label}</button>
          </li>`)}
    </ul>`;
    }
}
//# sourceMappingURL=menu.js.map