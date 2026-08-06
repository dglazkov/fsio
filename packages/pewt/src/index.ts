// @fsio/pewt library surface. The command line lives in cli.ts.
export { findPewter, pewterAt, ensureState, NotAPewter, type Pewter } from "./pewter.js";
export { listRepos, type Project } from "./repos.js";
export { bundleExtension, inline, BundleError, type Bundle } from "./bundle.js";
export { OPERATIONS, PROCESSES, byArgv, byMethod, processByMethod, OpError, type Operation, type ProcessOperation } from "./ops.js";
export { pewtKind } from "./kind.js";
export { runKind, planRun, asRunFrame, RunError, type RunSpec, type RunPlan, type RunFrame } from "./run.js";
export { spawnGate, terminalAsker, type Asker } from "./ask.js";
export { readGrants, writeGrants, recordGrant, revokeGrant, standingGrant, GrantsError, GRANTS_FILE } from "./grants.js";
export { serve, stop, DEFAULT_SHELL, type ServeOptions } from "./serve.js";
export { call, connect, CallError, type CallOptions } from "./call.js";
export { runOnHost, type RunOptions, type RunOutcome } from "./stream.js";
export { NodeDirectory } from "./node-fs.js";
export { parseArgs, type Parsed } from "./args.js";
