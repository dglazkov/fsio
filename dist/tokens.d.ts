/** The palette, as it is seen from inside an element. Put it first in any
 *  `static styles` that reads a `--_*` name. */
export declare const tokens: import("lit").CSSResult;
/** What every button in here starts from.
 *
 *  The three declarations are not taste, they are the shadow boundary: a
 *  `<button>` gets its font and its colour from the UA stylesheet rather
 *  than by inheritance, so one inside a shadow root ignores the page's font
 *  entirely unless it is told not to. Outside, `pewter-ui/style.css` says
 *  the same thing once for the whole document; in here each element has to
 *  say it for itself. */
export declare const control: import("lit").CSSResult;
//# sourceMappingURL=tokens.d.ts.map