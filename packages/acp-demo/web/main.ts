// acp-demo page (#18): a browser page that IS an ACP client. Conversation
// on the left, the live folder on the right, one directory handle powering
// both — and the agent's own permission prompts rendered as page UI rather
// than drawn inside a terminal (R6).
//
// Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md: the page reports, the
// native side reads verdicts).
import "./components/top-bar";
import "./components/chat";
import "./components/workspace-pane";
import "./components/wizard";
import { checkGates, closeOnPagehide } from "./connection";
import { phase } from "./state";
import { step } from "./reporter";

checkGates();
step("waiting for a folder");
phase.set("wizard");

// Closing the tab closes the session, which is what kills the agent (D6:
// the host owns cleanup, and an orphaned agent process would keep its
// model bill running).
window.addEventListener("pagehide", closeOnPagehide);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
