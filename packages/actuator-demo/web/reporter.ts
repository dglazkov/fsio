// The page's native-readable verdict for TESTING.md's cooperative loop.
import { createReporter } from "@fsio/ui";

export const { reporter, log, step } = createReporter({
  page: "actuator-demo",
  summaryKey: "tabs",
  facts: () => ({ channel: "demo-private/default", stateOwner: "indexeddb" }),
});
