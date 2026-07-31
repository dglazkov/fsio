// Daemon singleton (D21): one daemon per hub directory, enforced by an
// OS-level lock keyed by the hub's absolute path, held for the process
// lifetime, living in daemon-private state (D20).
//
// Why a bound socket rather than a lock file: D21 wants a *kernel-held*
// lock. Node exposes no `flock(2)`, but `bind(2)` on a unix domain socket
// (a named pipe on Windows) is the same shape of guarantee — while the
// owner lives, no second process can bind the same name, and the binding
// dies with the process, so the launchd restart race has no window. What a
// lock file cannot do, and why the alternatives were rejected in D21: an
// `O_EXCL` file survives a crash and strands the hub, `host.json` lives in
// the hub where a co-tenant can delete or backdate it, and a heartbeat is
// a heuristic that loses precisely the race a supervisor creates.
//
// The residue a unix socket leaves behind after a crash is a *file*, not a
// lock: it can be probed. `connect()` succeeding means a live owner (we
// refuse); ECONNREFUSED means nobody is listening (we reclaim it). A probe
// that hangs is treated as live — never steal a hub on a timeout.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hubKey } from "./state.js";

/** Thrown when another daemon already serves this hub. Callers exit
 *  non-zero without touching the hub (D21). */
export class HubLockedError extends Error {
  constructor(readonly hubDir: string, readonly lockPath: string) {
    super(`another fsiod already serves ${hubDir} (lock: ${lockPath})`);
    this.name = "HubLockedError";
  }
}

export interface HubLock {
  /** the socket/pipe the lock is held on (diagnostics). */
  readonly path: string;
  /** release for the rest of this process's life; idempotent. */
  release(): void;
}

// macOS caps sun_path at 104 bytes (Linux 108); bind() past it fails with
// a cryptic EINVAL. Kept a few bytes under so the margin is ours, not the
// kernel's.
const SUN_PATH_MAX = 100;

/** Where the lock for a hub lives. Windows uses a named pipe: no
 *  filesystem residue, no stale case to reclaim.
 *
 *  The socket wants to live beside the rest of the private state, but
 *  `sun_path` is a hard 104 bytes and a state dir is free to be deep (a
 *  sandboxed `FSIO_STATE_DIR`, a long `$HOME`). When it does not fit, fall
 *  back to the per-user runtime dir — `$XDG_RUNTIME_DIR` where the
 *  platform has one, else the temp dir, which on macOS is per-user and
 *  0700. Both are still outside the hub, which is the rule that matters
 *  (D20); the fallback is deterministic, so two starters always contend
 *  for the same name. */
export function lockPathFor(stateDir: string, hubDir: string): string {
  const key = hubKey(hubDir);
  if (process.platform === "win32") return `\\\\.\\pipe\\fsio-${key}`;
  const preferred = path.join(stateDir, "locks", `${key}.sock`);
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) return preferred;
  const runtime = process.env["XDG_RUNTIME_DIR"] || os.tmpdir();
  return path.join(runtime, `fsio-${key}.sock`);
}

const listen = (server: net.Server, p: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

/** Does something answer on this socket? `true` = a live owner. */
function probe(p: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(p);
    const done = (live: boolean) => {
      c.destroy();
      resolve(live);
    };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
    // Fail safe: a socket that neither connects nor refuses is not proof of
    // a corpse, and stealing a live hub means two daemons re-spawning every
    // session and minting competing epochs (D18).
    setTimeout(() => done(true), timeoutMs).unref();
  });
}

/** Take the hub's singleton lock, or throw `HubLockedError`. */
export async function acquireHubLock(stateDir: string, hubDir: string, probeTimeoutMs = 1000): Promise<HubLock> {
  const lockPath = lockPathFor(stateDir, hubDir);
  if (process.platform !== "win32") {
    if (Buffer.byteLength(lockPath) > SUN_PATH_MAX) {
      throw new Error(`lock path too long for a unix socket (${Buffer.byteLength(lockPath)} > ${SUN_PATH_MAX}): ${lockPath}`);
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  }

  const server = net.createServer();
  // Lock-only for now: a connection is a liveness probe from a would-be
  // second daemon, nothing more. (This socket is the natural home for a
  // later `fsio` → daemon control channel — it is already private, already
  // keyed by hub, and already proves the daemon is alive.)
  server.on("connection", (c) => c.destroy());
  server.on("error", () => {}); // post-listen errors must not crash the daemon

  const bind = async () => {
    await listen(server, lockPath);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(lockPath, 0o600);
      } catch {}
    }
  };

  try {
    await bind();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    if (await probe(lockPath, probeTimeoutMs)) throw new HubLockedError(hubDir, lockPath);
    // Stale: the owner died without unlinking. Reclaim, once — a second
    // EADDRINUSE means we lost the race to another starter, which is
    // exactly the outcome the lock exists to produce.
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    try {
      await bind();
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EADDRINUSE") throw new HubLockedError(hubDir, lockPath);
      throw e2;
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      server.close();
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    },
  };
}
