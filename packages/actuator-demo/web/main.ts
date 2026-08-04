// actuator-demo page: a small application that can be driven from a
// terminal on this machine.
//
// The inversion of the other two demos. There, the page reaches down and
// runs things on your machine; here the machine reaches up and changes what
// the page is showing — and the page's state never leaves the browser.
// Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md).
import "./boot-theme.js"; // must stay first — see that file
import "@fsio/ui"; // registers the shared chrome's custom elements
import "./components/app-shell";
import { reporter, step } from "./reporter";
import { checkGates, closeOnPagehide, revisit } from "./session";
import { app } from "./state";

// What the native side reads to learn what this page holds (TESTING.md).
reporter.summary = () => {
  const state = app.get();
  return state.tabs.map((t) => ({ ...t, active: t.id === state.activeId }));
};

checkGates();
step("waiting for a folder");
void revisit();

window.addEventListener("pagehide", closeOnPagehide);
// bfcache would revive a page whose session was just closed — reload so the
// revisit path runs fresh.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
