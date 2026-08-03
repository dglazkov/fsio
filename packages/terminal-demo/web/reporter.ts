// This page's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// and the native side reads verdicts out of there.
//
// The machinery is @fsio/ui's — it was this file and the agent demo's,
// identical but for two strings. These are the two strings, plus the one
// thing that is genuinely this page's: a notice belongs to page state, so
// raising one stays here.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";
import { notice } from "./state";

export const { reporter, logText, log, step } = createReporter({
  page: "terminal-demo",
  // What this page holds N of. `reporter.summary` is filled in by tabs.ts
  // (avoids an import cycle).
  summaryKey: "tabs",
  facts: () => ({ hasObserver }),
});

export function showNotice(msg: string, hint = ""): void {
  notice.set({ msg, hint });
  reporter.event("notice", { msg, hint, step: reporter.lastStep });
}
