// @fsio/pewt library surface. The command line lives in cli.ts.
export { findPewter, pewterAt, ensureState, NotAPewter, type Pewter } from "./pewter.js";
export { listRepos, type Project } from "./repos.js";
export { bundleExtension, inline, BundleError, type Bundle } from "./bundle.js";
export { OPERATIONS, byArgv, byMethod, OpError, type Operation } from "./ops.js";
export { pewtKind } from "./kind.js";
export { serve, stop, DEFAULT_SHELL, type ServeOptions } from "./serve.js";
export { call, CallError, type CallOptions } from "./call.js";
export { NodeDirectory } from "./node-fs.js";
export { parseArgs, type Parsed } from "./args.js";
