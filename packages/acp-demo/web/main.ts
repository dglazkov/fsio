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
import { checkGates, detachOnPagehide, revisit } from "./connection";
import { step } from "./reporter";

checkGates();
step("waiting for a folder");
// A remembered folder skips the wizard, and a remembered session skips the
// whole setup (#113): the page comes back to the conversation it left.
void revisit();

// Leaving the page DETACHES (D18) — the session, and the agent with it, keep
// running for the next visit. It used to close, which killed the agent
// (D6); a session now ends when the human ends it, and only then. See
// endSession() for the other half of that bargain.
window.addEventListener("pagehide", detachOnPagehide);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
