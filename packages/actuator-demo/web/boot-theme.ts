// The theme, installed before anything can paint without it.
//
// Same reason as the other two pages: `import` statements are hoisted, so a
// call between two imports still runs after both. main.ts imports this
// FIRST, and it reaches @fsio/ui/theme rather than @fsio/ui so the
// component barrel is not what drags the theme in.
import "@fontsource/instrument-serif";
import "@fontsource/jetbrains-mono";
import { installPageTheme } from "@fsio/ui/theme";

installPageTheme();
