// The daemon's command line, shared by the `fsiod` binary and
// `fsio daemon` (one implementation, two entry points).
import { startDaemon } from "./daemon.js";
import { HubLockedError } from "./lock.js";

export const DAEMON_USAGE = `usage: fsiod [--hub <dir>] [--allow-shell] [--quiet]

  --hub <dir>     the granted directory (default: $FSIO_HUB or ~/fsio)
  --allow-shell   allow process spawns WITHOUT a grant — development only;
                  the shipping default refuses them with 1007 until the
                  consent flow lands (D23)
  --quiet         errors only`;

const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);

/** Run the daemon in the foreground until a signal. Returns the process
 *  exit code; never returns while healthy. */
export async function runDaemon(argv: string[]): Promise<number> {
  const flags = { hub: undefined as string | undefined, allowShell: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--hub") flags.hub = argv[++i];
    else if (a === "--allow-shell") flags.allowShell = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a === "-h" || a === "--help") {
      console.log(DAEMON_USAGE);
      return 0;
    } else {
      console.error(`fsiod: unknown flag ${a}\n\n${DAEMON_USAGE}`);
      return 1;
    }
  }

  const log = {
    info: (...a: unknown[]) => (flags.quiet ? undefined : line("", a)),
    warn: (...a: unknown[]) => line("[warn]", a),
    error: (...a: unknown[]) => line("[error]", a),
  };

  let daemon;
  try {
    daemon = await startDaemon({
      ...(flags.hub ? { hub: flags.hub } : {}),
      allowShell: flags.allowShell,
      logger: log,
    });
  } catch (e) {
    // Losing the singleton race is an expected operator condition under a
    // supervisor, not a crash: one line, no stack, non-zero (D21).
    log.error(e instanceof HubLockedError ? e.message : e instanceof Error ? e.message : String(e));
    return 1;
  }

  const ws = daemon.registry.list();
  log.info(`fsiod serving hub ${daemon.hub}`);
  log.info(`  state: ${daemon.stateDir}${daemon.lock ? ` · lock: ${daemon.lock.path}` : ""}`);
  log.info(
    ws.length === 0
      ? "  workspaces: none — run `fsio share <dir>` (spawns get 1006 until then)"
      : `  workspaces: ${ws.map((w) => w.name).join(", ")}`
  );
  log.info(`  spawns: ${flags.allowShell ? "UNGRANTED SPAWNS ALLOWED (--allow-shell, development only)" : "refused (1007) until the consent flow lands"}`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void daemon.stop().then(() => process.exit(0));
    });
  }
  return await new Promise<number>(() => {}); // serve until signalled
}
