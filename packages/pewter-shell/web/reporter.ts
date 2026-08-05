// The shell's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json},
// and the native side reads the verdicts out of there.
//
// The machinery is @fsio/ui's. What is this page's is the list of facts a
// run needs to judge the skeleton: which extension is open, whether its
// frame really got an origin of its own, and every call it made.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";
import { open, opaque, served } from "./state";

export const { reporter, logText, log, step } = createReporter({
  page: "pewter-shell",
  summaryKey: "calls",
  facts: () => ({
    hasObserver,
    open: open.get(),
    // The claim the sandbox exists to make, as a fact a script can fail on.
    // null means no frame has loaded yet, which is not the same as false.
    opaqueOrigin: opaque.get(),
  }),
});

reporter.summary = () => served.get();
