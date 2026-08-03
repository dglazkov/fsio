// The theme, installed before anything can paint without it.
//
// This file exists for module-evaluation ORDER, which is the only reason it
// is not three lines at the top of main.ts. `import` statements are hoisted:
// every import in a module evaluates before any statement in its body, so a
// call sitting between two imports still runs after both of them. The custom
// elements are already in the HTML, so the moment @fsio/ui evaluates they
// upgrade and paint — against no wood, and (for anyone whose OS is dark)
// against whichever stain `light-dark()` guesses before `data-theme` is set.
//
// main.ts imports this FIRST, and it reaches @fsio/ui/theme rather than
// @fsio/ui so the component barrel is not what drags the theme in. Order:
// this module's imports, then installPageTheme(), then main.ts's remaining
// imports — the components included.
import "@fontsource/instrument-serif";
import "@fontsource/jetbrains-mono";
import { installPageTheme } from "@fsio/ui/theme";

installPageTheme();
