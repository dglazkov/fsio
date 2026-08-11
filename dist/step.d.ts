import { LitElement } from "lit";
import type { TemplateResult } from "lit";
/** How a step is going. `waiting` is the honest state for something that has
 *  been described but has not started, which is what an agent reports before
 *  it has permission. */
export type PewterStepState = "waiting" | "running" | "done" | "failed";
export declare class PewterStep extends LitElement {
    static properties: {
        label: {};
        state: {
            reflect: boolean;
        };
        paths: {
            attribute: boolean;
        };
    };
    /** What is being done, in the words of whatever is doing it. */
    label: string;
    state: PewterStepState;
    /** Files this step is about. Clicking one calls `onpath`. */
    paths: string[];
    /** Called with a path from `paths`; null leaves them as plain text. */
    onpath: ((path: string) => void) | null;
    static styles: import("lit").CSSResult[];
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-step": PewterStep;
    }
}
//# sourceMappingURL=step.d.ts.map