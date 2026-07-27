// The D14 seam, used for what it was built for: a PtyModule that wraps
// every spawn in `sandbox-exec -f sandbox.sb` so the shell the browser
// gets is confined to the shared folder (see profile.ts for the posture).
//
// Fail-closed by construction: HostServer falls back to an UNSANDBOXED
// pipe spawn if the injected PtyModule throws (host-server.ts startShell).
// That fallback is correct for the library and wrong for this demo, so
// this wrapper never throws — a spawn failure yields a dead pty that
// reports the error and exits 127. A broken sandbox must look broken,
// never silently degrade to an unconfined shell.
import fs from "node:fs";
import type { PtyModule, PtyProcess } from "@fsio/host";

export interface SandboxConfig {
  /** absolute path to the written profile (ROOT/.fsio/sandbox.sb). */
  profilePath: string;
  /** realpath of the shared directory. */
  root: string;
  /** realpath of ROOT/.fsio. */
  fsio: string;
  /** realpath of os.tmpdir(). */
  tmp: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Build the argv prefix; exported so the preflight and tests exercise the
 *  exact invocation the sessions will use (no drift — same reasoning as
 *  D12's resolveShell sharing). */
export function sandboxArgv(cfg: SandboxConfig, file: string, args: string[]): { file: string; args: string[] } {
  return {
    file: SANDBOX_EXEC,
    args: [
      "-f",
      cfg.profilePath,
      "-D",
      `ROOT=${cfg.root}`,
      "-D",
      `FSIO=${cfg.fsio}`,
      "-D",
      `TMP=${cfg.tmp}`,
      file,
      ...args,
    ],
  };
}

export function sandboxedPty(real: PtyModule, cfg: SandboxConfig): PtyModule {
  return {
    spawn(file, args, opts): PtyProcess {
      try {
        // Cheap invariants first: a missing profile or sandbox-exec binary
        // would otherwise surface as a confusing in-terminal error.
        fs.accessSync(cfg.profilePath, fs.constants.R_OK);
        fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
        const wrapped = sandboxArgv(cfg, file, args);
        return real.spawn(wrapped.file, wrapped.args, opts);
      } catch (e) {
        return deadPty(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/** A pty that was never born: delivers one explanatory line, then exit 127.
 *  Deferred a tick so the host can attach its onData/onExit listeners first
 *  (it registers them synchronously right after spawn returns). Accepts
 *  multiple listeners per the D14 PtyModule contract. */
function deadPty(reason: string): PtyProcess {
  const dataCbs: ((data: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number }) => void)[] = [];
  setTimeout(() => {
    for (const cb of dataCbs) cb(`sandbox spawn failed (refusing unsandboxed fallback): ${reason}\r\n`);
    for (const cb of exitCbs) cb({ exitCode: 127 });
  }, 0);
  return {
    pid: -1,
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}
