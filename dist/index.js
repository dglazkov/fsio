// The kit an extension imports: elements the compiler knows, and a screen
// that follows its own state.
//
//     import "pewter-ui";              registers <pewter-status>, <pewter-menu>
//     import "pewter-ui/style.css";    the page around them
//     import { screen } from "pewter-ui";
//
// The bare import is the whole setup, and the `HTMLElementTagNameMap`
// augmentations that ride the `.d.ts` are the discovery rail:
// `document.querySelector("pewter-menu")` comes back typed, the editor
// completes `.choices`, and `pewt check` fails a misuse the same way it
// fails a wrong `pewt.*` call. That is why these are elements rather than
// class names in a stylesheet — a class name is a string nothing checks, and
// an element is an API.
//
// **They are lit components with shadow roots.** Each one carries its own
// look in `static styles`, so it is right whether or not the stylesheet was
// imported, and an extension's CSS cannot reach in and break a row by
// accident. What an extension *can* reach is deliberate and small: the
// `--pewter-*` custom properties in tokens.ts, and the `part=` names on the
// markup inside. Both are listed in style.css, which is where somebody
// restyling a screen will be looking.
import { PewterMenu } from "./menu.js";
import { PewterStatus } from "./status.js";
export { PewterStatus } from "./status.js";
export { PewterMenu } from "./menu.js";
export { screen } from "./screen.js";
export { control, tokens } from "./tokens.js";
/** Each tab is its own document with its own registry, so this runs once per
 *  tab — the guard is for the harmless second import, not for clashes. */
const define = (tag, ctor) => {
    if (!customElements.get(tag))
        customElements.define(tag, ctor);
};
define("pewter-status", PewterStatus);
define("pewter-menu", PewterMenu);
//# sourceMappingURL=index.js.map