// The shell's half of the cooperative-verification loop (TESTING.md): it
// self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json},
// and the native side reads the verdicts out of there.
//
// The machinery is @fsio/ui's. What is this page's is the list of facts a
// run needs to judge it: what it has open, whether the frames really got an
// origin of their own, and every call it made.
import { hasObserver } from "@fsio/client";
import { createReporter } from "@fsio/ui";
import { bodyLabel } from "pewter";
import { content, opaque, opened, served, tabs } from "./state";

export const { reporter, logText, log, step } = createReporter({
  page: "pewter-shell",
  summaryKey: "calls",
  facts: () => {
    const { tabs: list, activeId, held } = tabs.get();
    return {
      hasObserver,
      // What is on screen, in the shape a rig has read since the skeleton:
      // the bundle behind the active tab, or null when nothing is.
      open: (activeId ? opened.get()[activeId] : null) ?? null,
      // The whole strip. The tabs are the page's own state, so a run driving
      // them from a terminal has no other way to see what landed.
      tabs: list.map((t) => ({ id: t.id, title: t.title, kind: t.body.kind, name: bodyLabel(t.body), active: t.id === activeId })),
      // The catalog, which outlives the tabs — and the only way a native side
      // can see that a copy really is the page's rather than a second read.
      held: held.map((f) => ({ id: f.id, name: f.name, from: f.from, size: f.size, type: f.type })),
      // What each file tab is actually showing. `missing` is the fact the
      // whole `open`/`fling` split turns on: delete the file, and a window
      // says so while a copy carries on.
      views: [...content.get().values()].map((v) => ({ key: v.key, viewer: v.viewer, size: v.size, missing: v.missing })),
      // The claim the sandbox exists to make, as a fact a script can fail on.
      // null means no frame has loaded yet, which is not the same as false.
      opaqueOrigin: opaque.get(),
    };
  },
});

reporter.summary = () => served.get();
