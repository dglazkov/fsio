import { LitElement } from "lit";
import type { TemplateResult } from "lit";
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
export declare class PewterStatus extends LitElement {
    #private;
    static properties: {
        text: {};
        action: {};
    };
    /** What the line says. */
    text: string;
    /** The label on the one thing to do about it. Empty means no button. */
    action: string;
    /** What that button does. Not a reactive property: it is a function, it
     *  never arrives as an attribute, and nothing on screen changes when it
     *  changes. */
    onact: (() => void) | null;
    static styles: import("lit").CSSResult[];
    /** Show the line with these words. Clears any offer — a new line is a new
     *  state, and the button that belonged to the old one goes with it. */
    say(text: string): void;
    /** Put one action beside the words, without changing them. */
    offer(label: string, act: () => void): void;
    /** The line has nothing to say. */
    hide(): void;
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-status": PewterStatus;
    }
}
//# sourceMappingURL=status.d.ts.map