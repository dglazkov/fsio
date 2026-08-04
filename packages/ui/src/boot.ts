// The theme and its fonts, installed before anything can paint without them.
//
// This module exists for module-evaluation ORDER, which is the only reason it
// is not three lines at the top of a page's main.ts. `import` statements are
// hoisted: every import in a module evaluates before any statement in its
// body, so a call sitting between two imports still runs after both of them.
// The custom elements are already in the HTML, so the moment @fsio/ui
// evaluates they upgrade and paint — against no wood, and (for anyone whose
// OS is dark) against whichever stain `light-dark()` guesses before
// `data-theme` is set.
//
// A page imports this FIRST and `@fsio/ui` after it. Order: this module's
// imports, then installPageTheme(), then the page's remaining imports — the
// component barrel included.
//
// It reaches ./theme.js rather than ./index.js for the same reason: the
// barrel is exactly what must not evaluate yet.
//
// The fonts are here because the theme is what names them — `--fsio-title` is
// Instrument Serif and `--fsio-mono` is JetBrains Mono, both declared in
// tokens.ts — so a page that adopts the theme and not the faces gets a
// wordmark in whatever the browser felt like. All three pages had written
// this file; it was identical in two of them and shorter by the same three
// lines in the third.
import "@fontsource/instrument-serif";
import "@fontsource/jetbrains-mono";
import { installPageTheme } from "./theme.js";

installPageTheme();
