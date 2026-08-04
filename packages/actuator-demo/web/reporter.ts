// This page's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// and the native side reads the verdicts out of there.
//
// The machinery is @fsio/ui's; these are the two strings that are this
// page's — what it is called, and what it holds N of.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";

export const { reporter, logText, log, step } = createReporter({
  page: "actuator-demo",
  summaryKey: "tabs",
  facts: () => ({ hasObserver }),
});
