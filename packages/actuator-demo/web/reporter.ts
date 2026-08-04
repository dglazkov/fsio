// This page's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// and the native side reads the verdicts out of there.
//
// The machinery is @fsio/ui's; these are the two strings that are this
// page's — what it is called, and what it holds N of.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";
import { app } from "./state";

export const { reporter, logText, log, step } = createReporter({
  page: "actuator-demo",
  summaryKey: "tabs",
  // The catalog of flung files, every flush. It is the one thing the native
  // side genuinely cannot see: the bytes are in the browser's storage, so
  // "did the fling land" is only answerable from in here (TESTING.md).
  facts: () => ({ hasObserver, held: app.get().held }),
});
