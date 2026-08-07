/** `<pewter-status>` — one quiet line above a screen: what just happened,
 *  and at most one thing to do about it.
 *
 *      status.say("the shell ended — exit 0");
 *      status.offer("new shell", () => again());
 *
 *  Extracted from the terminal and agent screens, which had each written
 *  exactly this line, its span, and its one button. */
export declare class PewterStatus extends HTMLElement {
    #private;
    connectedCallback(): void;
    /** Show the line with these words. Clears any offer — a new line is a new
     *  state, and the button that belonged to the old one goes with it. */
    say(text: string): void;
    /** Put one action beside the words, without changing them. */
    offer(label: string, act: () => void): void;
    /** The line has nothing to say. */
    hide(): void;
}
/** One row of `<pewter-menu>`: what the button says, and what a pick of it
 *  carries. The value is yours — the scaffolded screens use null for "this
 *  pewter" and a project name otherwise. */
export interface PewterMenuChoice {
    value: string | null;
    label: string;
}
/** `<pewter-menu>` — a list of choices, each row one full-width button.
 *
 *      menu.choices = [{ value: null, label: "this pewter" }, ...names];
 *      menu.onpick = (value) => open(value);
 *
 *  Setting `hints` instead replaces the list with plain rows — for when
 *  there is nothing to pick and the useful thing is to say why, which is
 *  the agent screen's empty roster. Extracted from the terminal and agent
 *  pickers, which had each written this list, its rows, and its refresh. */
export declare class PewterMenu extends HTMLElement {
    #private;
    /** Called with the picked row's value. One handler, not a bus: the
     *  screens this serves route every pick the same place. */
    onpick: ((value: string | null) => void) | null;
    connectedCallback(): void;
    get choices(): PewterMenuChoice[];
    set choices(rows: PewterMenuChoice[]);
    /** Plain rows in place of the choices: there is nothing to pick, and
     *  these lines say why. */
    set hints(lines: string[]);
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-status": PewterStatus;
        "pewter-menu": PewterMenu;
    }
}
//# sourceMappingURL=index.d.ts.map