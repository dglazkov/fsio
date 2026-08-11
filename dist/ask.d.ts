import { LitElement } from "lit";
import type { TemplateResult } from "lit";
/** One answer somebody can give.
 *
 *  `intent` is what the answer *means*, not what it looks like: an agent's
 *  option kinds (`allow_once`, `reject_always`) map onto it, and so does a
 *  confirm dialog's yes and no. The element decides the weight; a screen
 *  that had to pick colours would be deciding it twice. */
export interface PewterAskChoice {
    /** what comes back to `onpick`. */
    value: string;
    label: string;
    intent?: "affirm" | "deny";
}
export declare class PewterAsk extends LitElement {
    static properties: {
        question: {};
        who: {};
        choices: {
            attribute: boolean;
        };
        paths: {
            attribute: boolean;
        };
        answered: {};
        answeredLabel: {};
    };
    /** The question itself, in one line. */
    question: string;
    /** Who is asking, or what kind of thing this is — shown small, above.
     *  Empty is fine and common. */
    who: string;
    /** What can be answered. Empty renders no row, which is what an already
     *  answered or unanswerable question looks like. */
    choices: PewterAskChoice[];
    /** Files this question is about. Clicking one calls `onpath`. */
    paths: string[];
    /** The value that was answered, or empty while it is still open. Setting
     *  it replaces the choices with what was chosen — the card stays on screen
     *  as a record rather than vanishing, because a transcript of questions
     *  with the answers removed is not a transcript. */
    answered: string;
    /** What to call the answer, when it is not one of `choices` — a cancel, or
     *  an answer read back from somewhere the options are not known. */
    answeredLabel: string;
    /** Called with the chosen value, or null when the question was dismissed.
     *  Not a reactive property: it is a function. */
    onpick: ((value: string | null) => void) | null;
    /** Called with a path from `paths`. Null means the paths are not
     *  clickable, which is the honest state when a screen has nowhere to open
     *  one. */
    onpath: ((path: string) => void) | null;
    /** Whether to offer a way out beside the agent's own options. An agent's
     *  question always has one — refusing to answer is an answer — and a
     *  screen's own confirm may not want it. */
    dismissable: boolean;
    static styles: import("lit").CSSResult[];
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-ask": PewterAsk;
    }
}
//# sourceMappingURL=ask.d.ts.map