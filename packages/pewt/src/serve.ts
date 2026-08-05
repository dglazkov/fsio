// `pewt serve` — the host.
//
// One process per pewter, and the only one that can open sessions in the
// folder. The page is a client and the command line is a client; clients
// cannot talk to each other, so without this neither works. Starting a
// second host on the same folder fails, which @fsio/host already enforces
// (#40) and this only has to report.
//
// This host launches one thing: a script a project declares (`run`). `shell`
// and `agent` are the other two, and they are not built. So the spawn policy
// below has exactly one judgment to make, and it does not make it — it asks
// the human at this terminal (ask.ts) and reports the answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer, type HostLogger } from "@fsio/host";
import { spawnGate, terminalAsker, type Asker } from "./ask.js";
import { pewtKind } from "./kind.js";
import { hasClientDirs, openInChromium, pageIsWatching } from "./open.js";
import { ensureState, type Pewter } from "./pewter.js";
import { runKind } from "./run.js";

/** Where the shell lives. pewter.town is where it will be served from;
 *  until it deploys, this is the dev server (packages/pewter-shell), and
 *  `--url` moves it. */
export const DEFAULT_SHELL = "http://localhost:8769";

export interface ServeOptions {
  /** the shell's base URL. */
  url?: string;
  /** print the URL and open nothing. For scripts, ssh, and anyone who does
   *  not want a tab. */
  open?: boolean;
  /** allow every run without asking. For a rig, for CI, and for a host with
   *  no terminal in front of it — all of which would otherwise be denied,
   *  because a question nobody can answer is a denial. */
  allowRuns?: boolean;
  log?: HostLogger;
  /** where the question goes. The default is this process's terminal; tests
   *  pass their own. */
  asker?: Asker;
}

export async function serve(p: Pewter, opts: ServeOptions = {}): Promise<HostServer> {
  const log = opts.log ?? console;
  const base = opts.url ?? process.env["PEWT_SHELL"] ?? DEFAULT_SHELL;
  try {
    new URL(base);
  } catch {
    throw new Error(`--url ${JSON.stringify(base)} is not a URL`);
  }

  // F9: FileSystemObserver dies with InvalidModificationError under temp
  // directories, and a pewter run from there looks broken in ways nobody
  // would connect to where it lives. Refuse rather than warn.
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (p.root.startsWith("/private/tmp") || p.root.startsWith(tmpReal)) {
    throw new Error(`refusing to serve a pewter under a temp dir (${p.root}) — Chrome's file observers break there (F9)`);
  }

  ensureState(p);

  // Read before the `fresh` sweep empties it: a client directory that comes
  // back afterwards is a live page (open.ts).
  const folderHasSeenAPage = hasClientDirs(p.fsio);

  const asker = opts.asker ?? terminalAsker();
  const server = new HostServer({
    root: p.root,
    fresh: true,
    onSpawnRequest: spawnGate(p, { asker, ...(opts.allowRuns !== undefined ? { allowRuns: opts.allowRuns } : {}) }, log),
    // No shells here yet, so a missing node-pty is not worth a word about.
    pty: false,
    logger: log,
  });
  server.registerKind("pewt", pewtKind(p, log));
  server.registerKind("run", runKind(p, log));
  await server.start();

  console.log(`
pewter · ${p.root}
  ${countExtensions(p)}

  in the page: pick this folder — ${p.name} — and allow it. Those clicks are
  Chrome's own and cannot be automated (F15); they are also what stops the
  page from reaching anything you did not choose.

  from a terminal, in this folder:  pewt repos

  ${runPolicy(opts, asker)}

(Ctrl-C stops the host and sweeps .fsio)
`);

  console.log(`  ${base}\n`);
  if (opts.open === false) {
    console.log("--no-open: opening nothing. Paste that into a Chromium browser.\n");
  } else if (folderHasSeenAPage && (await pageIsWatching(p.fsio))) {
    console.log("a page is already open on this pewter — not opening another tab.\n");
  } else {
    const res = await openInChromium(base);
    console.log(res.opened ? `opened in ${res.browser}.\n` : `${res.why} — open that URL yourself, in Chrome or another Chromium.\n`);
  }

  return server;
}

/** What happens when something asks to run a script, said at startup rather
 *  than discovered at the first prompt — or, worse, at the first denial. */
function runPolicy(opts: ServeOptions, asker: Asker): string {
  if (opts.allowRuns) return "--allow-runs: every `pewt run` starts without asking. Nothing here will stop one.";
  if (!asker.ask) return "this host has no terminal to ask in, so it will deny every run. Restart it with --allow-runs to allow them.";
  return "a `pewt run` asks here first, every time, and starts nothing until you answer.";
}

/** What this pewter can show, said once at startup. A pewter with no
 *  extensions is not broken, but it is a page with nothing in it, and that
 *  is worth knowing before you go looking in the browser for the reason. */
function countExtensions(p: Pewter): string {
  let names: string[];
  try {
    names = fs
      .readdirSync(p.extensions, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return "no extensions/ directory — the page will have nothing to show.";
  }
  return names.length
    ? `extensions: ${names.join(", ")}`
    : "extensions/ is empty — the page will have nothing to show.";
}

/** Stop the host and leave the folder as it was found: sessions closed, the
 *  plumbing swept (D6 — the host owns .fsio cleanup), and the pages' own
 *  reports kept, because a page's report is the page's (#109). */
export async function stop(server: HostServer, p: Pewter, signal: string): Promise<void> {
  console.log(`\n${signal} — closing sessions…`);
  await server.close();
  server.cleanServiceDir(true);
  const clientDir = path.join(p.fsio, "client");
  const reports = fs.existsSync(clientDir) ? fs.readdirSync(clientDir).length : 0;
  console.log(reports ? `done; .fsio swept, ${reports} page report${reports === 1 ? "" : "s"} kept.` : "done; .fsio removed.");
}
