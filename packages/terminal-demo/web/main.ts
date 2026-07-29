// terminal-demo page (#16 S4, reshaped by #34): a terminal app that happens
// to need a one-time setup. The terminal IS the page — top bar with session
// tabs, full-viewport pane, status bar; setup is a wizard dialog floating
// over it (components/wizard.ts). Deliberately small; the measurement
// workbench keeps all the labs. Self-reports into
// <folder>/.fsio/client/<clientId>/{log.txt,report.json} for the
// cooperative verification loop (TESTING.md: the page reports, the native
// side reads verdicts).
import "@xterm/xterm/css/xterm.css";
import "./components/top-bar";
import "./components/terminal-pane";
import "./components/status-bar";
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
