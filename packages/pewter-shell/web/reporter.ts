// The shell's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json},
// and the native side reads the verdicts out of there.
//
// The machinery is @fsio/ui's. What is this page's is the list of facts a
// run needs to judge it: what it has open, whether the frames really got an
// origin of their own, and every call it made.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";
import { opaque, opened, served, tabs } from "./state";

export const { reporter, logText, log, step } = createReporter({
  page: "pewter-shell",
  summaryKey: "calls",
  facts: () => {
    const { tabs: list, activeId } = tabs.get();
    return {
      hasObserver,
      // What is on screen, in the shape a rig has read since the skeleton:
      // the bundle behind the active tab, or null when nothing is.
      open: (activeId ? opened.get()[activeId] : null) ?? null,
      // The whole strip. The tabs are the page's own state, so a run driving
      // them from a terminal has no other way to see what landed.
      tabs: list.map((t) => ({ id: t.id, title: t.title, name: t.body.name, active: t.id === activeId })),
      // The claim the sandbox exists to make, as a fact a script can fail on.
      // null means no frame has loaded yet, which is not the same as false.
      opaqueOrigin: opaque.get(),
    };
  },
});

reporter.summary = () => served.get();
