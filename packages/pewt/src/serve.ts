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
import { execKind } from "./exec.js";
import { spawnGate, terminalAsker, type Asker } from "./ask.js";
import { cloneKind } from "./clone.js";
import { installKind } from "./install.js";
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
  /** allow every exec without asking. Separate again, for the same reason. */
  allowExec?: boolean;
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
        ...(opts.allowExec !== undefined ? { allowExec: opts.allowExec } : {}),
      },
      log
    ),
    logger: log,
  });
  server.registerKind("pewt", pewtKind(p, router, log));
  server.registerKind("run", runKind(p, log));
  server.registerKind("exec", execKind(p, log));
  server.registerKind("agent", agentKind(p, log));
  server.registerKind("repos.clone", cloneKind(p, log));
  server.registerKind("repos.install", installKind(p, log));
  await server.start();

  // Identity, then anything this host will not ask about, then the page. Each
  // of the middle lines is conditional and most pewters print none of them: a
  // banner that recites what is about to happen normally teaches nothing,
  // because every question introduces itself in full when it arrives (ask.ts).
  // What cannot introduce itself is a question that will never be asked.
  const banner = [`\npewter · ${p.root}`];
  const missing = extensionsWarning(p);
  if (missing) banner.push(`  ${missing}`);
  const unasked = unaskedPolicy(p, opts, asker);
  if (unasked) banner.push(`  ${unasked}`);
  console.log(`${banner.join("\n")}\n`);

  // The last step is the human's, and it is the only instruction here — but
  // only when a page is actually being opened. A page already holding this
  // folder has already been picked and allowed, and telling its owner to do it
  // again is an instruction with nothing behind it.
  const pick = `pick this folder — ${p.name} — and allow it`;
  console.log(`  ${page.href}`);
  if (opts.open === false) {
    console.log(`  --no-open: paste that into a Chromium browser, then ${pick}.\n`);
  } else if (folderHasSeenAPage && (await pageIsWatching(p.fsio))) {
    console.log("  a page is already open on this pewter — not opening another tab.\n");
  } else {
    const res = await openInChromium(page.href);
    console.log(res.opened ? `  opened in ${res.browser} — ${pick}.\n` : `  ${res.why} — open that URL yourself, in Chrome or another Chromium, then ${pick}.\n`);
  }

  return server;
}

/** What this host will start **without asking** — and nothing else.
 *
 *  The ordinary pewter prints none of this, which is the point. Sentences
 *  previewing the questions that are coming were three lines of the banner and
 *  carried nothing the question does not say better when it arrives: `ask.ts`
 *  shows the command, the directory, that a shell is unconfined, and whether
 *  an agent asks before it edits, at the moment those facts decide something.
 *
 *  A question that will never be asked is the opposite. It cannot introduce
 *  itself, and a process starting in silence is the half a person cannot see —
 *  so a flag, a standing grant, and a host with no terminal each say so here. */
function unaskedPolicy(p: Pewter, opts: ServeOptions, asker: Asker): string | null {
  const standing = grantLine(p);
  if (!asker.ask) {
    const told = [opts.allowRuns ? "runs" : null, opts.allowShells ? "shells" : null, opts.allowAgents ? "agents" : null, opts.allowExec ? "programs" : null].filter(Boolean);
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
  const told = [
    opts.allowRuns ? "--allow-runs: every `pewt run` starts without asking." : null,
    opts.allowShells ? "--allow-shells: every `pewt shell` starts without asking." : null,
    opts.allowAgents ? "--allow-agents: every `pewt agent` starts without asking." : null,
    opts.allowExec ? "--allow-exec: every `pewt exec` starts without asking." : null,
    standing,
  ].filter((line): line is string => line !== null);
  return told.length ? told.join("\n  ") : null;
}

/** One line about what this host already remembers, or nothing when it
 *  remembers nothing — which is every pewter until somebody answers `a`. An
 *  unreadable grants file says so here rather than at the first question,
 *  because that is a broken file and not a broken run.
 *
 *  It names the file rather than `pewt grants`, and the reason is who is
 *  reading. This banner is printed on the host's terminal, which is the one
 *  place `pewt` is not on `PATH` — `run.ts`'s `childEnv` and `agent.ts`'s
 *  `agentEnv` put it there for the scripts and agents that call back in, and
 *  those are who the command line is for. A person standing where this prints
 *  is not expected to run `pewt` at all, so the honest pointer is the folder
 *  they already have. Reading it, not writing it: the host stays the only
 *  writer (grants.ts). */
function grantLine(p: Pewter): string | null {
  let grants;
  try {
    grants = readGrants(p);
  } catch (e) {
    return `${GRANTS_FILE} cannot be read (${e instanceof Error ? e.message : String(e)}), so nothing will start until it is fixed or deleted.`;
  }
  if (grants.length === 0) return null;
  return `${grants.length} standing grant${grants.length === 1 ? "" : "s"} — these start without asking. They are in ${GRANTS_FILE}.`;
}

/** Said only when this pewter has no screens. A roster of directory names told
 *  a reader what they are about to see anyway, in the browser, by name — but a
 *  page with nothing in it looks broken, and the reason is on this side of the
 *  folder where nobody would think to look for it. */
function extensionsWarning(p: Pewter): string | null {
  let names: string[];
  try {
    names = fs
      .readdirSync(p.extensions, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return "no extensions/ directory — the page will have nothing to show.";
  }
  return names.length ? null : "extensions/ is empty — the page will have nothing to show.";
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
