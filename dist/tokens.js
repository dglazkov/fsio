// The kit's vocabulary, for a shadow root.
//
// Every element here renders into a shadow root, and a shadow root sees no
// page CSS: `pewter-ui/style.css` styles the page *around* an element and
// stops at its boundary. Custom properties do cross that boundary, which is
// what makes this file a theme rather than a second copy of the stylesheet.
//
// **Each name reads the page's, and falls back to the kit's.** That double
// spelling — a private `--_line` computed from a public `--pewter-line` with
// a default built in — is the whole design, and it buys both halves at once:
//
//   - an extension that imports `pewter-ui` and *not* its stylesheet still
//     gets elements that look right, because the default is in here;
//   - an extension that sets `--pewter-line` anywhere above the element
//     overrides it from outside, knowing nothing about what is inside.
//
// A bare `--pewter-line: …` declared on `:host` would give the first and
// destroy the second: it would shadow whatever the page set, and there would
// be no way to reach past it. This is the standard way to make a shadow
// boundary themeable, and it is why the names below come in pairs.
//
// `color-scheme` is deliberately absent. It inherits, so an element follows
// whatever the page settled on; declaring it here would re-open the
// light/dark question inside every element and answer it from the OS
// preference instead — the bug `@fsio/ui`'s tokens.ts documents having
// measured, where the component layer inverted and the page did not.
import { css } from "lit";
/** The palette, as it is seen from inside an element. Put it first in any
 *  `static styles` that reads a `--_*` name. */
export const tokens = css `
  :host {
    /* three weights of the same edge: row separators, controls, emphasis */
    --_hairline: var(--pewter-hairline, light-dark(#0001, #fff2));
    --_line: var(--pewter-line, light-dark(#0003, #fff3));
    --_line-strong: var(--pewter-line-strong, light-dark(#0004, #fff4));

    /* a raised control, and the wash a pointer leaves over a flat one */
    --_raised: var(--pewter-raised, light-dark(#fff, #222228));
    --_wash: var(--pewter-wash, light-dark(#0000000d, #ffffff0d));
  }
`;
/** What every button in here starts from.
 *
 *  The three declarations are not taste, they are the shadow boundary: a
 *  `<button>` gets its font and its colour from the UA stylesheet rather
 *  than by inheritance, so one inside a shadow root ignores the page's font
 *  entirely unless it is told not to. Outside, `pewter-ui/style.css` says
 *  the same thing once for the whole document; in here each element has to
 *  say it for itself. */
export const control = css `
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
//# sourceMappingURL=tokens.js.map