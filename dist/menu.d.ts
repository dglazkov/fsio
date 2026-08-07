import { LitElement } from "lit";
import type { TemplateResult } from "lit";
/** One row: what the button says, and what a pick of it carries. The value
 *  is yours — the scaffolded screens use null for "this pewter" and a project
 *  name otherwise. */
export interface PewterMenuChoice {
    value: string | null;
    label: string;
}
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
export declare class PewterMenu extends LitElement {
    #private;
    /** Called with the picked row's value. One handler, not a bus: the screens
     *  this serves route every pick the same place, and a property binds in a
     *  template as readily as an event listener would. */
    onpick: ((value: string | null) => void) | null;
    static styles: import("lit").CSSResult[];
    /** Reactive by hand rather than through `static properties`, because
     *  setting either of these has to clear the other — and an accessor lit
     *  generated would have nowhere to put that. `requestUpdate()` is the whole
     *  contract a property has to keep. */
    get choices(): PewterMenuChoice[];
    set choices(rows: PewterMenuChoice[]);
    /** Plain rows in place of the choices: there is nothing to pick, and these
     *  lines say why. */
    get hints(): string[];
    set hints(lines: string[]);
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-menu": PewterMenu;
    }
}
//# sourceMappingURL=menu.d.ts.map