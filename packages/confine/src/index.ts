// @fsio/confine — the Seatbelt write wall, extracted.
//
// Both demos wrote this: a profile that lets a child read the world and
// write only the folder the human granted, minus the protocol's own area,
// plus holes it declares. `sandboxArgv` had the identical signature in both
// files before either of them knew about the other, which is what a library
// looks like when nobody specified it.
//
// The line this package draws: it emits policy and argv, and it does not
// spawn. See argv.ts for why that is the one divergence between the two
// implementations and why it stayed with the callers.
export { SANDBOX_EXEC, sandboxArgv, assertSandboxUsable, type SandboxConfig } from "./argv.js";
export { sandboxProfile, profileSummary, type Carve, type ProfileInputs } from "./profile.js";
