// Running a child under a Seatbelt profile: the argv, and the two invariants
// that must hold before it is worth building.
//
// This module does not spawn. Both demos wrote their own spawn path — one
// wraps a PtyModule, one calls child_process.spawn — and they disagree about
// what to do when confinement is unavailable, which is a policy the library
// must not hold. terminal-demo said so in a comment before this package
// existed: HostServer falls back to an unsandboxed pipe spawn if the injected
// PtyModule throws, and "that fallback is correct for the library and wrong
// for this demo."
//
// So the split is: this file says what the invocation IS and whether it can
// run; the caller decides what a failure means. `assertSandboxUsable` throws,
// and throwing is the whole API — one consumer lets it propagate into a
// refused spawn, the other catches it and hands back a process that reports
// the failure and exits 127. Both are fail-closed. Neither is here.
import fs from "node:fs";

/** The system binary. Not configurable: a profile applied by something else
 *  is not the thing these tests measured. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The four paths a profile is parameterized by.
 *
 *  All four must be realpaths — Seatbelt matches kernel-real paths, so a
 *  `/var/…` symlink resolves to `/private/var/…` before any rule sees it and
 *  an unresolved path silently matches nothing. */
export interface SandboxConfig {
  /** absolute path to the profile text on disk, written by the host. */
  profilePath: string;
  /** realpath of the shared directory — the folder the browser picked. */
  root: string;
  /** realpath of ROOT/.fsio, the protocol area (host-owned, D6). */
  fsio: string;
  /** realpath of the scratch dir the child gets as TMPDIR. */
  tmp: string;
}

/** Build the argv prefix. Pure, and exported rather than inlined so tests,
 *  preflights and labs exercise the exact invocation sessions use — the same
 *  no-drift reasoning as D12's shared resolveShell. */
export function sandboxArgv(cfg: SandboxConfig, file: string, args: readonly string[]): { file: string; args: string[] } {
  return {
    file: SANDBOX_EXEC,
    args: ["-f", cfg.profilePath, "-D", `ROOT=${cfg.root}`, "-D", `FSIO=${cfg.fsio}`, "-D", `TMP=${cfg.tmp}`, file, ...args],
  };
}

/** The cheap invariants, checked before a spawn: the profile is readable and
 *  `sandbox-exec` is executable. Without them a missing file surfaces as an
 *  unexplained child exit — a confusing line in a terminal, or a 1002 whose
 *  text says nothing. Throws; the caller owns what that means. */
export function assertSandboxUsable(cfg: SandboxConfig): void {
  fs.accessSync(cfg.profilePath, fs.constants.R_OK);
  fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
}
