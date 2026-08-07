// `pewt serve` — the host.
//
// One process per pewter, and the only one that can open sessions in the
// folder. The page is a client and the command line is a client; clients
// cannot talk to each other, so without this neither works. Starting a
// second host on the same folder fails, which @fsio/host already enforces
// (#40) and this only has to report.
//
// This host launches three things: a script a project declares (`run`), a
// shell (`shell`), and an ACP adapter this pewter depends on (`agent`). The
// spawn policy below makes none of those judgments itself — it asks the human
// at this terminal (ask.ts) and reports the answer.
//
// Nothing confines what it starts. The whole control is that question, which
// is what NARRATIVE.md describes: settled with the owner on 2026-08-05, and
// written into the narrative's "Looking into the Future" rather than left as
// an omission a reader has to notice. `terminal-demo` confines its shells to
// the shared folder with @fsio/confine; that wall is macOS-only, and
// inheriting it here would have made a pewter's shells silently
// platform-shaped and broken every one that needs ~/.ssh or ~/.npm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer, type HostLogger } from "@fsio/host";
import { agentKind } from "./agent.js";
import { spawnGate, terminalAsker, type Asker } from "./ask.js";
import { GRANTS_FILE, readGrants } from "./grants.js";
import { pewtKind } from "./kind.js";
import { hasClientDirs, openInChromium, pageIsWatching } from "./open.js";
import { ensureState, type Pewter } from "./pewter.js";
import { Router } from "./router.js";
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
  /** allow every shell without asking. Separate from `allowRuns` on purpose
   *  (P3): a rig told it could build has not been told it can do anything. */
  allowShells?: boolean;
  /** allow every agent without asking. Separate again, for the same reason. */
  allowAgents?: boolean;
  log?: HostLogger;
  /** where the question goes. The default is this process's terminal; tests
   *  pass their own. */
  asker?: Asker;
}

export async function serve(p: Pewter, opts: ServeOptions = {}): Promise<HostServer> {
  const log = opts.log ?? console;
  const base = opts.url ?? process.env["PEWT_SHELL"] ?? DEFAULT_SHELL;
  let page: URL;
  try {
    page = new URL(base);
  } catch {
    throw new Error(`--url ${JSON.stringify(base)} is not a URL`);
  }
  // Which folder this host serves, named in the URL. The shell remembers the
  // last folder it held (#185), and this hint is what keeps that memory from
  // outranking the host that opened the page: a remembered folder that is not
  // this one defers to the picker instead of auto-connecting (#124's lesson).
  page.searchParams.set("dir", p.name);

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
  // Where a command for the page goes. One per host, because a pewter is one
  // folder and one shell: the page's session is what commands are delivered
  // down, and the newest page to open takes that place (router.ts).
  const router = new Router();
  const server = new HostServer({
    root: p.root,
    fresh: true,
    onSpawnRequest: spawnGate(
      p,
      {
        asker,
        ...(opts.allowRuns !== undefined ? { allowRuns: opts.allowRuns } : {}),
        ...(opts.allowShells !== undefined ? { allowShells: opts.allowShells } : {}),
        ...(opts.allowAgents !== undefined ? { allowAgents: opts.allowAgents } : {}),
      },
      log
    ),
    logger: log,
  });
  server.registerKind("pewt", pewtKind(p, router, log));
  server.registerKind("run", runKind(p, log));
  server.registerKind("agent", agentKind(p, log));
  await server.start();

  console.log(`
pewter · ${p.root}
  ${countExtensions(p)}

  in the page: pick this folder — ${p.name} — and allow it. Those clicks are
  Chrome's own and cannot be automated (F15); they are also what stops the
  page from reaching anything you did not choose.

  from a terminal, in this folder:  pewt repos

  ${runPolicy(p, opts, asker)}

(Ctrl-C stops the host and sweeps .fsio)
`);

  console.log(`  ${page.href}\n`);
  if (opts.open === false) {
    console.log("--no-open: opening nothing. Paste that into a Chromium browser.\n");
  } else if (folderHasSeenAPage && (await pageIsWatching(p.fsio))) {
    console.log("a page is already open on this pewter — not opening another tab.\n");
  } else {
    const res = await openInChromium(page.href);
    console.log(res.opened ? `opened in ${res.browser}.\n` : `${res.why} — open that URL yourself, in Chrome or another Chromium.\n`);
  }

  return server;
}

/** What happens when something asks to start a process, said at startup
 *  rather than discovered at the first prompt — or, worse, at the first
 *  denial. Three flags, so up to three sentences: they are separate
 *  capabilities and a host can have been told about one and not the others.
 *
 *  Standing grants get a line of their own when there are any. What this host
 *  will not ask about is the half a person cannot see, and reading it off a
 *  banner beats discovering it when something starts in silence. */
function runPolicy(p: Pewter, opts: ServeOptions, asker: Asker): string {
  const standing = grantLine(p);
  if (!asker.ask) {
    const told = [opts.allowRuns ? "runs" : null, opts.allowShells ? "shells" : null, opts.allowAgents ? "agents" : null].filter(Boolean);
    const list = told.length > 1 ? `${told.slice(0, -1).join(", ")} and ${told[told.length - 1]}` : told[0];
    // A host with no terminal still honours what somebody already answered:
    // "cannot ask" is about the question, not about the memory of one.
    const cannot = list
      ? `this host has no terminal to ask in. It allows ${list} because it was told to in advance, and denies everything else.`
      : "this host has no terminal to ask in, so it denies every run, shell and agent. Restart it with --allow-runs, --allow-shells or --allow-agents to allow them.";
    return standing ? `${cannot}\n  ${standing}` : cannot;
  }
  // Each sentence stands alone: a host can have been told about runs and not
  // shells, and a shared clause would then be wrong about one of them.
  const runs = opts.allowRuns ? "--allow-runs: every `pewt run` starts without asking." : "a `pewt run` asks here first, and starts nothing until you answer.";
  const shells = opts.allowShells
    ? "--allow-shells: every `pewt shell` starts without asking."
    : "a `pewt shell` asks here too, and what it starts is unconfined.";
  const agents = opts.allowAgents
    ? "--allow-agents: every `pewt agent` starts without asking."
    : "a `pewt agent` asks here too, and that question says whether the agent will ask you back.";
  return [runs, shells, agents, ...(standing ? [standing] : [])].join("\n  ");
}

/** One line about what this host already remembers, or nothing when it
 *  remembers nothing — which is every pewter until somebody answers `a`. An
 *  unreadable grants file says so here rather than at the first question,
 *  because that is a broken file and not a broken run. */
function grantLine(p: Pewter): string | null {
  let grants;
  try {
    grants = readGrants(p);
  } catch (e) {
    return `${GRANTS_FILE} cannot be read (${e instanceof Error ? e.message : String(e)}), so nothing will start until it is fixed or deleted.`;
  }
  if (grants.length === 0) return null;
  return `${grants.length} standing grant${grants.length === 1 ? "" : "s"} — these start without asking. \`pewt grants\` lists them.`;
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
