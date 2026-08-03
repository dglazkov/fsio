// @fsio/ui — the chrome the two demo pages had both written.
//
// An extraction, not a design (PROCESS.md rule 6): every component in here
// existed twice before it existed once, and what survived the merge is
// whatever the two copies already agreed on. What they disagreed on became a
// prop, so neither page had to adopt the other's words.
//
// Importing a component registers its custom element — these are side-effect
// imports on purpose, the same way a page imports its own components.
import "./components/cmd.js";
import "./components/details.js";
import "./components/session-row.js";
import "./components/tab-strip.js";
import "./components/wizard-frame.js";

export { ago, friendlyName, sinceLabel, sizeOf } from "./text.js";
export { Dismiss } from "./dismiss.js";
export { Reporter, createReporter } from "./reporter.js";
export type { PageReporter, ReporterOptions } from "./reporter.js";
export {
  controls,
  dialogChrome,
  diagBody,
  listBody,
  panel,
  prose,
  statusLines,
  tokens,
  wizardStyles,
} from "./tokens.js";
export type { Chip, ChipAction, ChipDot, ConfirmCopy } from "./components/tab-strip.js";
export type { Crumb } from "./components/wizard-frame.js";
