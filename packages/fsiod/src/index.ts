// @fsio/fsiod library surface. The binaries are cli.ts (`fsio`) and
// fsiod.ts (`fsiod`); everything they do is importable here so tests and
// future embedders (the consent server, the installer) share one
// implementation.
export { startDaemon, type Daemon, type DaemonOptions } from "./daemon.js";
export { runDaemon, DAEMON_USAGE } from "./daemon-cli.js";
export { acquireHubLock, lockPathFor, HubLockedError, type HubLock } from "./lock.js";
export { Registry, defaultName, isValidName, REGISTRY_FILE, type AddOptions, type WorkspaceEntry } from "./registry.js";
export {
  ensureStateDir,
  stateDirPath,
  hubDirPath,
  hubKey,
  assertOutsideHub,
  writeStateFile,
  HUB_ENV,
  STATE_ENV,
} from "./state.js";
