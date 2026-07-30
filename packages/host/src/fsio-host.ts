#!/usr/bin/env node
// fsio host CLI: a thin wrapper over HostServer (the library; see #17).
//
// Usage:
//   node packages/host/dist/fsio-host.js <dir> [--allow-shell] [--poll <ms>] [--no-watch] [--fresh] [--takeover]
//
//   --allow-shell   permit `kind: "shell"` sessions (spawns processes!)
//   --hot <ms>      hot-poll interval while traffic is flowing (default 5, 0=off;
//                   gated on recent traffic, not session liveness — F22)
//   --poll <ms>     add an unconditional poll loop at <ms> interval
//   --no-watch      disable fs.watch (pure polling; use with --poll to measure)
//   --fresh         wipe .fsio on startup
//   --takeover      start even if host.json looks live (#40) — for a killed
//                   host whose last heartbeat hasn't gone stale yet

import { HostServer } from "./host-server.js";

const args = process.argv.slice(2);
const flags = { allowShell: false, poll: 0, hot: 5, watch: true, fresh: false, takeover: false };
let rootArg: string | null = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--allow-shell") flags.allowShell = true;
  else if (a === "--poll") flags.poll = Number(args[++i]);
  else if (a === "--hot") flags.hot = Number(args[++i]);
  else if (a === "--no-watch") flags.watch = false;
  else if (a === "--fresh") flags.fresh = true;
  else if (a === "--takeover") flags.takeover = true;
  else if (!a.startsWith("-")) rootArg = a;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(1);
  }
}
if (!rootArg) {
  console.error("usage: fsio-host <dir> [--allow-shell] [--poll ms] [--no-watch] [--fresh] [--takeover]");
  process.exit(1);
}

// Timestamped, level-tagged lines (HostLogger is leveled — D14).
const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const server = new HostServer({
  root: rootArg,
  allowShell: flags.allowShell,
  fresh: flags.fresh,
  takeover: flags.takeover,
  watch: flags.watch,
  hotPollMs: flags.hot,
  pollMs: flags.poll,
  logger: log,
});

try {
  await server.start();
} catch (e) {
  // The live-host refusal (#40) is an expected operator condition, not a
  // crash — one clear line, no stack.
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

log.info(`fsio host on ${server.fsioDir}`);
log.info(`  shell sessions: ${server.allowShell ? "ALLOWED" : "disabled (--allow-shell to enable)"}`);
log.info(
  `  wakeup: ${flags.watch ? "fs.watch" : "no fs.watch"}${flags.poll ? ` + ${flags.poll}ms poll` : ""}${flags.hot ? ` + ${flags.hot}ms hot poll while active` : ""} + ${server.timings.safetyPollMs}ms safety poll`
);

// SIGTERM too (pkill's default — dev.sh and the rig stop hosts that way):
// an unhandled TERM leaves host.json behind looking live for 3 beats,
// which the #40 refusal would then hold against the next host.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // await the reap (D14): children get SIGTERM → killGraceMs → SIGKILL
    void server.close().then(() => process.exit(0));
  });
}
