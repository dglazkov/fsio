// acp-demo page (#18): a browser page that IS an ACP client. Conversation
// on the left, the live folder on the right, one directory handle powering
// both — and the agent's own permission prompts rendered as page UI rather
// than drawn inside a terminal.
//
// Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md: the page reports, the
// native side reads verdicts).
import "./boot-theme.js"; // must stay first — see that file
import "@fsio/ui"; // registers the shared chrome's custom elements
import "./components/top-bar";
import "./components/chat";
import "./components/details";
import "./components/workspace-pane";
import "./components/wizard";
import { checkGates, revisit } from "./connection";
import { detachAllOnPagehide } from "./conversations";
import { reporter, step } from "./reporter";
import { launch } from "./state";
import { parseLaunch } from "../src/launch.js";

checkGates();
// Read before anything else looks at it, and read once: the helper's hints
// describe the moment this page was opened, and a later re-read would be
// answering a question about a URL the page has since rewritten (#120 owns
// the hash). Purely advisory — see launch.ts.
launch.set(parseLaunch(location.search));
reporter.event("launch", { ...launch.get(), openedByHelper: launch.get().dir !== null });
step("waiting for a folder");
// A remembered folder skips the wizard, and a remembered set of sessions
// skips the whole setup (#113, #120): the page comes back to the
// conversations it left — or, if the URL names them, to the ones it was
// handed (P1: the URL travels, the data stays).
void revisit();

// Leaving the page DETACHES every conversation (D18) — the sessions, and the
// agents with them, keep running for the next visit. It used to close, which
// killed the agent (D6); a conversation now ends when the human ends it, and
// only then. See closeConv() for the other half of that bargain.
window.addEventListener("pagehide", detachAllOnPagehide);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
