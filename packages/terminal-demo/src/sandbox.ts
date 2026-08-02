// The D14 seam, used for what it was built for: a PtyModule that wraps every
// spawn in `sandbox-exec -f sandbox.sb` so the shell the browser gets is
// confined to the shared folder (profile.ts for the posture, @fsio/confine
// for the wall).
//
// What is left here after the extraction is exactly this demo's *failure
// policy*, and that is the reason it did not move. HostServer falls back to
// an UNSANDBOXED pipe spawn if the injected PtyModule throws
// (host-server.ts startShell). That fallback is correct for the library and
// wrong for this demo, so this wrapper never throws — a spawn failure yields
// a dead pty that reports the error and exits 127. A broken sandbox must
// look broken, never silently degrade to an unconfined shell.
import { assertSandboxUsable, sandboxArgv, type SandboxConfig } from "@fsio/confine";
import type { PtyModule, PtyProcess } from "@fsio/host";

export function sandboxedPty(real: PtyModule, cfg: SandboxConfig): PtyModule {
  return {
    spawn(file, args, opts): PtyProcess {
      try {
        // Cheap invariants first: a missing profile or sandbox-exec binary
        // would otherwise surface as a confusing in-terminal error.
        assertSandboxUsable(cfg);
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
