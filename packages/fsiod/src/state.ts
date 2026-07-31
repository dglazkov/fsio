// Daemon-private state (D20): where fsiod keeps the things a co-tenant
// must not be able to read, forge, or delete.
//
// The hub folder is granted whole — Chrome grants folders, not subtrees —
// so every file in it is readable and writable by every granted origin and
// by every local process running as the user. That disqualifies it from
// holding anything authoritative: the workspace registry, grant records,
// profiles, and the singleton lock all live *here* instead, outside the
// grant, mode 0700.
//
// `FSIO_STATE_DIR` relocates it (tests are hermetic that way, and it is
// the only supported way to run two daemons on one machine without them
// sharing a registry).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STATE_ENV = "FSIO_STATE_DIR";
export const HUB_ENV = "FSIO_HUB";

type Env = Record<string, string | undefined>;

/** Where daemon-private state lives, per platform convention. Not created
 *  by this call — see `ensureStateDir`. */
export function stateDirPath(env: Env = process.env): string {
  const override = env[STATE_ENV];
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "fsio");
  if (process.platform === "win32") return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "fsio");
  return path.join(env["XDG_STATE_HOME"] ?? path.join(home, ".local", "state"), "fsio");
}

/** The hub: the one directory a page grants, ever (D19). Working name
 *  `~/fsio`; `FSIO_HUB` moves it. */
export function hubDirPath(env: Env = process.env): string {
  return path.resolve(env[HUB_ENV] ?? path.join(os.homedir(), "fsio"));
}

/** Create (or repair) the state dir and return it. Permissions are part of
 *  the mechanism, not decoration: state that other users can read is state
 *  a co-tenant could have read anyway, which would defeat the point of
 *  moving it out of the hub. */
export function ensureStateDir(env: Env = process.env): string {
  const dir = stateDirPath(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for an existing dir; force it.
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}

/** realpath, resolving as much of the path as exists. A path that is not
 *  created yet still has to be *compared* correctly — its existing
 *  ancestors are where the symlinks live. */
export function realpathish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** D20's containment rule, checked rather than assumed: private state
 *  inside the granted folder is not private. Throws with the reason. */
export function assertOutsideHub(stateDir: string, hubDir: string): void {
  // Compare real paths: on macOS the temp dir alone is two names for one
  // directory (`/var/…` → `/private/var/…`), and a containment check that
  // a symlink defeats is not a check.
  const rel = path.relative(realpathish(hubDir), realpathish(stateDir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(
      `daemon state (${stateDir}) is inside the hub (${hubDir}) — every granted origin could read and forge it (D20). ` +
        `Move it with ${STATE_ENV}.`
    );
  }
}

/** Stable short key for a hub directory: what the lock and any per-hub
 *  state are filed under. Realpath'd so two names for one directory
 *  (symlink, `/tmp` vs `/private/tmp`) cannot yield two locks. */
export function hubKey(hubDir: string): string {
  const real = realpathish(hubDir);
  // 12 hex: this key becomes a unix-socket file name, and sun_path is 104
  // bytes on macOS — every character spent here is one the state dir cannot
  // have. Collision resistance is irrelevant; distinctness among a user's
  // handful of hubs is the whole requirement.
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
}

/** Atomic, private write for state files (temp + rename, 0600). */
export function writeStateFile(file: string, data: string): void {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
