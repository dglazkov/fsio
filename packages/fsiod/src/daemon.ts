// fsiod: the hub daemon (#71). It is an *embedder* of @fsio/host (D13/D14),
// not a fork of it — the library stays folder-agnostic and the one-folder
// mode remains both the hermetic test substrate and the fallback. What the
// daemon adds is everything the library must not know about: which folder
// is the hub, which workspaces exist, who may run what.
//
// What is here (slice 1 of #71): the singleton lock (D21), the workspace
// registry wired to the host's D22 resolver, and a fail-closed policy.
// What is not, in order: the service directory (D24) and capability names
// (D25), profile content and env policy (from #46), the consent server
// (D23; its answer channel gated on #79), the one-recursive-watcher scan
// loop (F22), and `fsio daemon install` (launchd).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer, type HostLogger, type HostTimings } from "@fsio/host";
import { RpcErrors } from "@fsio/common";
import { acquireHubLock, type HubLock } from "./lock.js";
import { Registry } from "./registry.js";
import { assertOutsideHub, ensureStateDir, hubDirPath } from "./state.js";

export interface DaemonOptions {
  /** the granted directory. Default `~/fsio` (or `FSIO_HUB`). */
  hub?: string;
  /** daemon-private state root. Default per platform (`FSIO_STATE_DIR`). */
  stateDir?: string;
  /** Development stand-in for the D23 grant that does not exist yet: it
   *  makes the workspace path exercisable end to end. Without it the
   *  daemon refuses every process spawn with `1007`, which is the shipping
   *  posture until consent lands. */
  allowShell?: boolean;
  logger?: HostLogger;
  timings?: HostTimings;
  watch?: boolean;
  hotPollMs?: number;
  pollMs?: number;
  /** skip the lock — tests that run several daemons on one hub only. */
  lock?: boolean;
  /** hermetic tests only: serve a hub under the temp dir. A real hub there
   *  is useless (F9 kills the browser's observers) and expensive to
   *  discover, which is why the default is a refusal, not a warning. */
  allowTempHub?: boolean;
}

export interface Daemon {
  readonly hub: string;
  readonly stateDir: string;
  readonly server: HostServer;
  readonly registry: Registry;
  readonly lock: HubLock | null;
  stop(): Promise<void>;
}

const SILENT: HostLogger = { info() {}, warn() {}, error() {} };

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const log = opts.logger ?? SILENT;
  const hub = path.resolve(opts.hub ?? hubDirPath());
  fs.mkdirSync(hub, { recursive: true });
  const hubReal = fs.realpathSync(hub);

  // F9: FileSystemObserver dies with InvalidModificationError under /tmp.
  // A hub there looks broken in ways nobody would connect to the folder
  // choice, and the hub is granted once ever — a bad one is expensive.
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (!opts.allowTempHub && (hubReal.startsWith("/private/tmp") || hubReal.startsWith(tmpReal))) {
    throw new Error(`refusing to serve a hub under a temp dir (${hubReal}) — Chrome's file observers break there (F9)`);
  }

  const stateDir = opts.stateDir ? (fs.mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 }), path.resolve(opts.stateDir)) : ensureStateDir();
  assertOutsideHub(stateDir, hubReal); // D20, checked rather than assumed

  const lock = opts.lock === false ? null : await acquireHubLock(stateDir, hubReal);
  const registry = new Registry(stateDir);

  const server = new HostServer({
    root: hubReal,
    workspaces: registry.resolver(),
    // Two authorizations, deliberately not one (D23): the grant is standing
    // authority, this hook is the per-request judgment, and execution needs
    // both. Until grants exist there is no standing authority to check, so
    // the honest answer to every spawn is `1007` — the client's next move
    // (ask for consent) is exactly what the code is missing.
    onSpawnRequest: (_spec, info) => {
      if (info.kind !== "shell") return true; // hub-confined kinds may be served ungranted (D23 rule 1)
      if (!opts.allowShell) {
        return {
          allow: false,
          code: RpcErrors.GRANT_REQUIRED,
          reason: "no grant covers this request — the consent flow is not implemented yet (#71)",
        };
      }
      log.warn(
        `● ungranted spawn allowed by --allow-shell — origin: ${info.origin ?? "(none reported)"} · workspace: ${info.workspace ?? "(default)"} · ${info.cmd}`
      );
      return true;
    },
    logger: log,
    ...(opts.timings ? { timings: opts.timings } : {}),
    ...(opts.watch === undefined ? {} : { watch: opts.watch }),
    ...(opts.hotPollMs === undefined ? {} : { hotPollMs: opts.hotPollMs }),
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
  });

  try {
    await server.start();
  } catch (e) {
    lock?.release();
    throw e;
  }

  let stopped = false;
  return {
    hub: hubReal,
    stateDir,
    server,
    registry,
    lock,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.close();
      lock?.release();
    },
  };
}
