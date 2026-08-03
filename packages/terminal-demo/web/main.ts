// terminal-demo page (#16 S4, reshaped by #34): a terminal app that happens
// to need a one-time setup. The terminal IS the page — one bar naming the
// folder and the shells open in it, the pane under it taking everything
// else, and an "i" in the corner for the times the page is behaving oddly.
// Setup is a dialog floating over all of it (components/wizard.ts).
// Deliberately small; the measurement workbench keeps all the labs.
// Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md: the page reports, the
// native side reads verdicts).
import "@xterm/xterm/css/xterm.css";
import "@fsio/ui"; // registers the shared chrome's custom elements
import "./components/top-bar";
import "./components/terminal-pane";
import "./components/details";
import "./components/wizard";
import { step } from "./reporter";
import { checkGates, revisit } from "./connection";
import { detachAllOnPagehide } from "./tabs";

checkGates();
step("waiting for a folder");
void revisit();

window.addEventListener("pagehide", detachAllOnPagehide);
// bfcache restore would revive a page whose sessions were just torn down —
// reload instead so the revisit path (picker) runs fresh.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
