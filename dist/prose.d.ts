import { LitElement } from "lit";
import type { TemplateResult } from "lit";
/** Render markdown source as lit templates, without an element around it.
 *
 *  Exported because a screen that already has its own bubble — a permission
 *  card, a tool call's detail — wants the prose inside markup it controls,
 *  and wrapping that in a custom element would put a shadow boundary in the
 *  middle of its own layout. The element below is this plus a place to stand. */
export declare function renderMarkdown(src: string): TemplateResult;
export declare class PewterMarkdown extends LitElement {
    static properties: {
        text: {};
    };
    /** The markdown to show. Set it again with more of it while a turn
     *  streams; an unterminated fence renders as code rather than as
     *  backticks (markdown.ts). */
    text: string;
    static styles: import("lit").CSSResult[];
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "pewter-markdown": PewterMarkdown;
    }
}
//# sourceMappingURL=prose.d.ts.map