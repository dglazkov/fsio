// The operations, in one table.
//
// This file is the claim in NARRATIVE.md's "One API, two ways in" made
// structural rather than asserted: an operation declares how a terminal
// spells it, how the wire spells it, how to check what arrived, what it
// does, and what a terminal prints. The CLI reads the table, the session
// kind reads the table, and adding an operation adds both front ends because
// there is nowhere to add one to.
//
// The spellings differ where each side has its own conventions — `pewt
// repos` against `repos.list` — and the operation does not.
//
// There are two families in this file and they split by *shape*: a request
// has one answer, and a process has a stream that ends in an exit code.
//
// Requests split again, by *who answers*. `repos`, `ext` and `agents` are the
// host's, because the answer is on the machine. `tabs` and `files` are the
// page's: a tab is not on disk anywhere — it exists because a browser is open
// — and a flung copy is in that browser's storage, which the machine cannot
// see either. An operation says which it is and nothing else changes: the same
// table, the same two spellings, the same one place to add the next one. What
// differs is where the answer comes from, and router.ts is what carries a
// command to a page and a receipt back.
import { asTabCommand, bodyLabel, describeAsks, describeGrant, grantId, shellSpec, sizeText, type Grant, type HeldFile, type TabsListing } from "pewter";
import { roster, type RosterEntry } from "./agents.js";
import { bundleExtension, BundleError, listExtensions, type Bundle, type Extension } from "./bundle.js";
import { GrantsError, readGrants, revokeGrant } from "./grants.js";
import { createRepo, listRepos, ReposError, type Project } from "./repos.js";
import type { Pewter } from "./pewter.js";

/** An operation said no. Distinct from a transport failure: the request
 *  arrived, was understood, and the answer was no.
 *
 *  `hint` is what to do instead, and it is not decoration — an agent reading
 *  stderr can act on a hint and cannot act on a tone. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "OpError";
  }
}

/** One operation, with its type erased so the table can hold all of them.
 *  Each definition below keeps its own parameter and result types; `define`
 *  is the one place the erasure happens. */
export interface Operation {
  /** the wire name, and the RPC method a session carries. */
  method: string;
  /** how a terminal spells it: the words before the arguments. */
  cli: string[];
  /** one line, for `pewt help`. */
  summary: string;
  /** the argument shape, for `pewt help`. Empty when it takes none. */
  usage: string;
  /** argv after the command words → params, as the wire would carry them. */
  fromArgv(argv: string[]): unknown;
  /** what arrived → what this operation will accept. Both front ends land
   *  here, because anything that can write the folder can write anything
   *  (spec/PROTOCOL.md, threat model) and the CLI is not a trusted caller
   *  either — it is just another client. */
  parse(params: unknown): unknown;
  /** the host's answer, or absent when the page has it. A page operation is
   *  forwarded down the session the page holds (router.ts) and the host never
   *  learns what the answer means. */
  run?(p: Pewter, params: unknown): Promise<unknown>;
  /** what a terminal prints. `--json` prints the result instead. */
  render(result: unknown): string;
}

interface Def<P, R> {
  method: string;
  cli: string[];
  summary: string;
  usage?: string;
  fromArgv(argv: string[]): P;
  parse(params: unknown): P;
  run(p: Pewter, params: P): Promise<R>;
  render(result: R): string;
}

const define = <P, R>(d: Def<P, R>): Operation => ({
  method: d.method,
  cli: d.cli,
  summary: d.summary,
  usage: d.usage ?? "",
  fromArgv: (argv) => d.fromArgv(argv),
  parse: (params) => d.parse(params),
  run: (p, params) => d.run(p, params as P),
  render: (result) => d.render(result as R),
});

/** A page operation: everything an operation has except an answer. Written as
 *  its own constructor rather than an optional field on `define` so that
 *  forgetting the host's half is impossible rather than merely unlikely. */
const definePage = <P, R>(d: Omit<Def<P, R>, "run">): Operation => ({
  method: d.method,
  cli: d.cli,
  summary: d.summary,
  usage: d.usage ?? "",
  fromArgv: (argv) => d.fromArgv(argv),
  parse: (params) => d.parse(params),
  render: (result) => d.render(result as R),
});

/** Whether the host answers this one itself. The kind reads it to decide
 *  between its own table and the page's session. */
export const hostAnswers = (op: Operation): boolean => op.run !== undefined;

const noParams = (): Record<string, never> => ({});

/** A string field, or the refusal that names it. */
function str(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string" || value === "") {
    throw new OpError("bad_params", `${key} is required and must be a string`);
  }
  return value;
}

export const reposList = define<Record<string, never>, { repos: Project[] }>({
  method: "repos.list",
  cli: ["repos"],
  summary: "the projects in this pewter",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ repos: await listRepos(p) }),
  render: ({ repos }) => {
    // An empty pewter is the normal first state, so the empty answer's one
    // job is the next step. The clone-restore surprise — `repos/` is
    // git-ignored, so projects do not travel with a pewter — belongs to the
    // moment someone clones, and it lives in the scaffold's AGENTS.md and the
    // narrative, not here (#188).
    if (repos.length === 0) {
      return "no projects yet — repos/ is empty.\n  Start one:   pewt repos create <name>\n  Clone one:   pewt repos clone <url>";
    }
    const width = Math.max(...repos.map((r) => r.name.length));
    const state = (r: Project): string => (r.git ? (r.branch ?? "detached") : "(not a git repository)");
    const stateWidth = Math.max(...repos.map((r) => state(r).length));
    // The scripts are the row's verbs: what `pewt run <name> --repo <repo>`
    // can start, straight from that project's own package.json.
    return repos
      .map((r) => `  ${r.name.padEnd(width)}  ${state(r).padEnd(stateWidth)}  ${r.scripts.length ? r.scripts.join(", ") : "(no scripts)"}`)
      .join("\n");
  },
});

export const reposCreate = define<{ name: string }, { repo: Project }>({
  method: "repos.create",
  cli: ["repos", "create"],
  summary: "start a new project in repos/",
  usage: "<name>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "repos create takes one project name");
    return { name: argv[0] };
  },
  parse: (params) => ({ name: str(params, "name") }),
  // No question. It is a mkdir and a `git init` in the folder the caller was
  // already granted, and git init executes nothing — the same reasoning that
  // left `ext.bundle` and `pewt check` unasked (#189).
  run: async (p, { name }) => {
    try {
      return { repo: await createRepo(p, name) };
    } catch (e) {
      if (e instanceof ReposError) throw new OpError(e.code, e.message, e.hint);
      throw e;
    }
  },
  render: ({ repo }) => `${repo.name} → repos/${repo.name}/ — a git repository${repo.branch ? ` on ${repo.branch}` : ""}, ready to work in`,
});

export const extList = define<Record<string, never>, { extensions: Extension[] }>({
  method: "ext.list",
  cli: ["ext"],
  summary: "the screens this pewter holds",
  usage: "",
  fromArgv: (argv) => {
    if (argv.length) throw new OpError("usage", "ext takes no arguments — `pewt ext bundle <name>` builds one");
    return {};
  },
  parse: () => ({}),
  // Unasked, and it reads a directory the caller was already granted. The
  // same reasoning as `ext.bundle` beside it (#189).
  run: async (p) => ({ extensions: await listExtensions(p) }),
  render: ({ extensions }) => {
    if (extensions.length === 0) return "no extensions yet — extensions/ is empty, so the page has nothing to show.";
    return extensions.map((e) => (e.ready ? `  ${e.name}` : `  ${e.name} — no ${e.missing}, so it cannot be opened`)).join("\n");
  },
});

export const extBundle = define<{ name: string }, Bundle>({
  method: "ext.bundle",
  cli: ["ext", "bundle"],
  summary: "build one extension into a single HTML file",
  usage: "<name>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "ext bundle takes one extension name");
    return { name: argv[0] };
  },
  parse: (params) => ({ name: str(params, "name") }),
  run: async (p, { name }) => {
    try {
      return await bundleExtension(p, name);
    } catch (e) {
      // esbuild's diagnostics are the useful half of a compile failure, so
      // they travel as the message rather than being summarized into one.
      if (e instanceof BundleError) throw new OpError(e.code, e.message, e.hint);
      throw new OpError("build_failed", e instanceof Error ? e.message : String(e));
    }
  },
  render: (b) =>
    `${b.name} → ${b.path}  (${sizeText(b.bytes)}, ${b.hash})` +
    (b.rebuilt ? `\n  rebuilt in ${b.ms} ms` : "\n  already newer than its sources — nothing to do"),
});

export const agentsList = define<Record<string, never>, { agents: RosterEntry[] }>({
  method: "agents.list",
  cli: ["agents"],
  summary: "the ACP adapters this pewter depends on",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ agents: roster(p) }),
  render: ({ agents }) => {
    const here = agents.filter((a) => a.installed);
    if (here.length === 0) {
      return [
        "no agents in this pewter — an adapter is an ordinary dependency, so add one:",
        ...agents.map((a) => `  ${a.install.padEnd(44)}${describeAsks(a.asks)}`),
        "",
        "It is pinned in your lockfile, `npm rm` removes it, and `git clone && npm i`",
        "brings it back on another machine.",
      ].join("\n");
    }
    const width = Math.max(...here.map((a) => a.name.length));
    return here
      .map((a) => {
        // Whether it asks before it edits is the reason this list exists, so
        // it is the column, and a version nobody measured says so in the same
        // breath rather than in a footnote somebody has to go and find.
        const asks = a.asks === false ? "edits with its own hands — nothing will ask you" : describeAsks(a.asks);
        const doubt = a.unmeasured ? ` (measured at ${a.measured}, this is ${a.version ?? "unknown"})` : "";
        return `  ${a.name.padEnd(width)}  ${a.version ?? "?"}  ${asks}${doubt}`;
      })
      .join("\n");
  },
});

// ---- the answers this host remembers
//
// A grant is the host's, so these are the host's: it asks the question, so it
// owns what was answered and it is the only writer of the file (grants.ts).
//
// Both are on the same table as everything else, which means an extension can
// call them. That is not a hole, because neither one widens anything: the only
// gesture that *makes* a grant is a human typing `a` at the host's terminal
// (P5 — a rung's enforcer must not benefit from the software asking), and the
// only thing an extension can do here is read the list or make the host ask
// again.

/** A grants file that cannot be read or a grant that is not there, in the
 *  vocabulary the table already speaks. */
const asOpError = (e: unknown): never => {
  if (e instanceof GrantsError) throw new OpError(e.code, e.message, e.hint);
  throw e;
};

export const grantsList = define<Record<string, never>, { grants: Grant[] }>({
  method: "grants.list",
  cli: ["grants"],
  summary: "the answers this host remembers",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => {
    try {
      return { grants: readGrants(p) };
    } catch (e) {
      return asOpError(e);
    }
  },
  render: ({ grants }) => {
    if (grants.length === 0) {
      return [
        "no standing grants — every run and every agent asks on the host's terminal.",
        "  Answer `a` to one of those questions to record one. A shell never gets one:",
        "  it is unconfined, so an `always` there would be `always, anything`.",
      ].join("\n");
    }
    // The id is first because it is what `pewt grants revoke` takes, and the
    // sentence beside it is what the id means — `run/fsio` is short enough to
    // type and too short to be the only thing a person reads before revoking.
    const width = Math.max(...grants.map((g) => grantId(g).length));
    return grants.map((g) => `  ${grantId(g).padEnd(width)}  ${describeGrant(g)}  ·  since ${g.granted.slice(0, 10)}`).join("\n");
  },
});

export const grantsRevoke = define<{ id: string }, { id: string; grant: Grant }>({
  method: "grants.revoke",
  cli: ["grants", "revoke"],
  summary: "take back a standing grant",
  usage: "<id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "grants revoke takes one grant id — `pewt grants` lists them");
    return { id: argv[0] };
  },
  parse: (params) => ({ id: str(params, "id") }),
  run: async (p, { id }) => {
    try {
      return { id, grant: revokeGrant(p, id) };
    } catch (e) {
      return asOpError(e);
    }
  },
  render: ({ id, grant }) => `revoked ${id} — ${describeGrant(grant)}\n  the next one asks on the host's terminal again`,
});

// ---- the operations the page answers
//
// Same table, same two spellings, no `run`. What a terminal types travels to
// the host, the host forwards it down the session the page holds, and the
// receipt comes back the way any answer does. The page checks the parameters
// again when they arrive (`asTabCommand`, in the `pewter` package) — this
// check is what a terminal gets a usage error from, not what makes the
// command safe.

/** The page's own parameter check, phrased for whoever typed it. */
const tabParams =
  (method: string, what: string, hint?: string) =>
  (params: unknown): Record<string, unknown> => {
    const cmd = asTabCommand(method, params);
    if (!cmd) throw new OpError("bad_params", what, hint);
    return cmd.params as Record<string, unknown>;
  };

/** The refusal a path outside the pewter gets. One sentence for both file
 *  commands, because it is one rule: the page's reach is exactly the folder
 *  you granted it, and neither command moves bytes across that edge. */
const OUTSIDE = "paths are relative to the pewter, and a path that climbs out of it is not one the page can read";

const tabId = (argv: string[], verb: string): { id: string } => {
  if (argv.length !== 1 || !argv[0]) throw new OpError("usage", `tabs ${verb} takes one tab id — \`pewt tabs\` lists them`);
  return { id: argv[0] };
};

export const tabsList = definePage<Record<string, never>, TabsListing>({
  method: "tabs.list",
  cli: ["tabs"],
  summary: "what the page has open",
  fromArgv: noParams,
  parse: tabParams("tabs.list", "tabs takes no parameters") as (params: unknown) => Record<string, never>,
  render: ({ tabs, activeId }) => {
    if (tabs.length === 0) {
      return "no tabs — the page is open and holding nothing.\n  Put something in it:  pewt tabs add <extension>";
    }
    const width = Math.max(...tabs.map((t) => t.title.length));
    // The id is first because it is what every other tab command takes, and
    // the mark says which one you are looking at right now. The last column is
    // what is in the tab, which is a name, a path, or a copy — `bodyLabel` is
    // the one place that decides, so the strip in the browser says the same.
    return tabs
      .map((t) => `  ${t.id === activeId ? "▸" : " "} ${t.id}  ${t.title.padEnd(width)}  ${bodyLabel(t.body)}`)
      .join("\n");
  },
});

export const tabsAdd = definePage<{ name: string; args?: unknown }, { id: string; name: string; title: string; active: boolean }>({
  method: "tabs.add",
  cli: ["tabs", "add"],
  summary: "open an extension in a new tab",
  usage: "<extension> [args-json]",
  fromArgv: (argv) => {
    const [name, args, ...extra] = argv;
    if (!name || extra.length > 0) {
      throw new OpError("usage", "tabs add takes an extension name and, optionally, one JSON value the tab opens with");
    }
    if (args === undefined) return { name };
    // The same value an extension would pass to `pewt.tabs.add` — parsed
    // here so what travels is a JSON value, not a string that might be one.
    try {
      return { name, args: JSON.parse(args) };
    } catch {
      throw new OpError("usage", `${JSON.stringify(args)} is not JSON — quote it for your shell, like '{"repo":"fsio"}'`);
    }
  },
  parse: tabParams("tabs.add", "tabs add needs an extension name") as (params: unknown) => { name: string; args?: unknown },
  // A tab twice is two tabs, so this says which one it made. The build that
  // had to happen first is the page's business and does not show up here —
  // when it fails, this operation is refused with the compile error instead.
  render: ({ id, name, title, active }) =>
    `${name} → ${id}${title === name ? "" : ` (${title})`}${active ? "" : "  · left in the strip, not brought forward"}`,
});

export const tabsUpdate = definePage<{ id: string; title: string }, { id: string; title: string }>({
  method: "tabs.update",
  cli: ["tabs", "update"],
  summary: "rename a tab",
  usage: "<id> <title>",
  fromArgv: (argv) => {
    if (argv.length !== 2 || !argv[0] || !argv[1]) throw new OpError("usage", 'tabs update takes a tab id and a title — `pewt tabs update tab-9f2c "Build log"`');
    return { id: argv[0], title: argv[1] };
  },
  parse: tabParams("tabs.update", "tabs update needs a tab id and a title") as (params: unknown) => { id: string; title: string },
  render: ({ id, title }) => `${id} → ${JSON.stringify(title)}`,
});

export const tabsClose = definePage<{ id: string }, { id: string; activeId: string | null }>({
  method: "tabs.close",
  cli: ["tabs", "close"],
  summary: "close a tab",
  usage: "<id>",
  fromArgv: (argv) => tabId(argv, "close"),
  parse: tabParams("tabs.close", "tabs close needs a tab id") as (params: unknown) => { id: string },
  // What is on screen now is the half nobody thinks to ask for and everybody
  // wants next: closing the tab you were looking at moves you somewhere.
  render: ({ id, activeId }) => `closed ${id}${activeId ? `  · ${activeId} is on screen now` : "  · the page is holding nothing now"}`,
});

export const tabsFocus = definePage<{ id: string }, { id: string; title: string }>({
  method: "tabs.focus",
  cli: ["tabs", "focus"],
  summary: "bring a tab forward",
  usage: "<id>",
  fromArgv: (argv) => tabId(argv, "focus"),
  parse: tabParams("tabs.focus", "tabs focus needs a tab id") as (params: unknown) => { id: string },
  render: ({ id, title }) => `${id} is on screen — ${JSON.stringify(title)}`,
});

// ---- the two file verbs
//
// Both take a path inside the pewter, and the page reads it through the grant
// it already holds — the same trick an extension's bundle rides. So no bytes
// go on the wire in either direction, `fling` has no size limit of this
// table's choosing, and a path outside the folder is refused rather than
// resolved. The difference between them is what the page does with the read:
// `open` keeps the path and looks again, `fling` keeps the bytes and stops
// looking.

/** The one argument both file commands take. */
const filePath = (argv: string[], verb: string): { path: string } => {
  if (argv.length !== 1 || !argv[0]) throw new OpError("usage", `${verb} takes one path inside this pewter`);
  return { path: argv[0] };
};

export const filesOpen = definePage<{ path: string }, { id: string; path: string; title: string; active: boolean; reused: boolean }>({
  method: "files.open",
  cli: ["open"],
  summary: "show a file from this pewter, as a window on it",
  usage: "<path>",
  fromArgv: (argv) => filePath(argv, "open"),
  parse: tabParams("files.open", "open needs a path inside this pewter", OUTSIDE) as (params: unknown) => { path: string },
  // Whether a window was already on it is the half nobody asks for and
  // everybody wants next: `pewt open` twice is one tab, on purpose, and a
  // second id would be the more surprising answer to report.
  render: ({ id, path, reused }) => `${path} → ${id}${reused ? "  · the window already on it, brought forward" : ""}`,
});

export const filesFling = definePage<{ path: string }, { fileId: string; id: string; name: string; size: number; superseded: string | null }>({
  method: "files.fling",
  cli: ["fling"],
  summary: "give the page a copy of a file, which outlives the file",
  usage: "<path>",
  fromArgv: (argv) => filePath(argv, "fling"),
  parse: tabParams("files.fling", "fling needs a path inside this pewter", OUTSIDE) as (params: unknown) => { path: string },
  render: ({ fileId, id, name, size, superseded }) =>
    `${name} → ${fileId} (${sizeText(size)}), in ${id}` +
    (superseded ? `\n  replaced ${superseded} — the same path, flung again` : "") +
    "\n  the page holds these bytes now: delete the file, stop the host, revoke the folder, and the tab still works",
});

export const filesList = definePage<Record<string, never>, { files: HeldFile[] }>({
  method: "files.list",
  cli: ["files"],
  summary: "the copies the page has custody of",
  fromArgv: noParams,
  parse: tabParams("files.list", "files takes no parameters") as (params: unknown) => Record<string, never>,
  render: ({ files }) => {
    if (files.length === 0) {
      return "no copies — this page holds nothing of its own.\n  Give it one:  pewt fling <path>";
    }
    const width = Math.max(...files.map((f) => f.name.length));
    // `from` is provenance and nothing more: the copy is not looking at that
    // path any more, which is the entire difference from `pewt open`.
    return files
      .map((f) => `  ${f.id}  ${f.name.padEnd(width)}  ${sizeText(f.size).padStart(7)}  was ${f.from}`)
      .join("\n");
  },
});

export const filesShow = definePage<{ id: string }, { id: string; fileId: string; name: string; reused: boolean }>({
  method: "files.show",
  cli: ["files", "show"],
  summary: "put a copy the page holds back in a tab",
  usage: "<file id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "files show takes one file id — `pewt files` lists them");
    return { id: argv[0] };
  },
  parse: tabParams("files.show", "files show needs a file id") as (params: unknown) => { id: string },
  render: ({ id, name, reused }) => `${name} → ${id}${reused ? "  · the tab already on it, brought forward" : ""}`,
});

export const filesDrop = definePage<{ id: string }, { id: string; name: string; closedTabs: number }>({
  method: "files.drop",
  cli: ["files", "drop"],
  summary: "forget a copy and free its bytes",
  usage: "<file id>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "files drop takes one file id — `pewt files` lists them");
    return { id: argv[0] };
  },
  parse: tabParams("files.drop", "files drop needs a file id") as (params: unknown) => { id: string },
  // The tabs are worth saying out loud: dropping bytes closes windows onto
  // them, and a tab vanishing with no line about it is the confusing kind.
  render: ({ id, name, closedTabs }) =>
    `dropped ${name} (${id})` + (closedTabs ? `  · closed ${closedTabs} tab${closedTabs === 1 ? "" : "s"} showing it` : ""),
});

export const OPERATIONS: Operation[] = [
  reposList,
  reposCreate,
  extList,
  extBundle,
  agentsList,
  grantsList,
  grantsRevoke,
  tabsList,
  tabsAdd,
  tabsUpdate,
  tabsClose,
  tabsFocus,
  filesOpen,
  filesFling,
  filesList,
  filesShow,
  filesDrop,
];

export const byMethod = (method: string): Operation | undefined =>
  OPERATIONS.find((o) => o.method === method);

// ---- the second family: operations that start a process
//
// A request has one answer; a run has a stream that ends in an exit code, so
// it cannot be an `Operation` and is not pretending to be one. What it shares
// with the table above is everything that keeps the two front ends from
// drifting: one entry, one spelling on each side, one place to add the next
// one (`agent` lands here).
//
// The two in it are not built the same way, and the difference is worth
// knowing before reading further. `run` is a session kind this project wrote,
// so its spec is its own and the host resolves it. `shell` is @fsio/host's
// kind — the library has the pty, the resize plumbing and the flow control —
// so its spec is the library's, and the translation from `--repo site` to a
// working directory happens on the client (packages/pewter/src/shell.ts).

/** One process operation. `method` is what an extension calls and what the
 *  session's kind is named — the same word, because the session IS the call. */
export interface ProcessOperation {
  method: string;
  cli: string[];
  summary: string;
  usage: string;
  /** whether `--repo` means anything here. */
  repo: boolean;
  /** argv after the command words → what was asked for, minus the repo. */
  fromArgv(argv: string[]): Record<string, unknown>;
  /** what was asked for → the spec a session carries. The command line lands
   *  here (args.ts); an extension is in a browser and lands on the same
   *  translation in the `pewter` package instead. */
  parse(params: unknown): Record<string, unknown>;
}

export const runProcess: ProcessOperation = {
  method: "run",
  cli: ["run"],
  summary: "run a script the project declares",
  usage: "<script>",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "run takes one script name");
    return { script: argv[0] };
  },
  // The script is checked against the project's package.json when the run is
  // planned (run.ts), which is the only check that means anything: a name
  // that is not in that file is not runnable however well-formed it looks.
  parse: (params) => ({ script: str(params, "script"), ...repoOf(params) }),
};

export const execProcess: ProcessOperation = {
  method: "exec",
  cli: ["exec"],
  summary: "run a program and read what it printed",
  usage: "<program> [args…]",
  repo: true,
  fromArgv: (argv) => {
    if (!argv.length || !argv[0]) throw new OpError("usage", "exec takes a program and its arguments");
    // Everything after the program is an argument, verbatim. No splitting and
    // no quoting rules of our own: the shell the human typed at already did
    // that, and there is no second shell on the other end to do it again.
    return { cmd: argv[0], args: argv.slice(1) };
  },
  parse: (params) => {
    const given = (params as Record<string, unknown> | null)?.["args"] ?? [];
    if (!Array.isArray(given) || given.some((a) => typeof a !== "string")) {
      throw new OpError("bad_params", "args must be a list of strings");
    }
    return { cmd: str(params, "cmd"), args: given as string[], ...repoOf(params) };
  },
};

/** The optional project name, in the one shape every operation reads it. */
function repoOf(params: unknown): { repo?: string } {
  const value = (params as Record<string, unknown> | null)?.["repo"];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value === "") throw new OpError("bad_params", "repo must be a project name");
  return { repo: value };
}

export const shellProcess: ProcessOperation = {
  method: "shell",
  cli: ["shell"],
  summary: "open a shell on your machine",
  usage: "",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 0) throw new OpError("usage", "shell takes no arguments — `--repo <name>` picks the project");
    return {};
  },
  // The spec that goes on the wire is @fsio/host's, not this table's, so this
  // reads `--repo` and hands it to the one function both front ends translate
  // with (packages/pewter/src/shell.ts). What the host checks is the resolved
  // directory, which is the only check that means anything.
  parse: (params) => shellSpec(repoOf(params)),
};

export const agentProcess: ProcessOperation = {
  method: "agent",
  cli: ["agent"],
  summary: "start an ACP agent on a project",
  usage: "[name]",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 1) throw new OpError("usage", "agent takes at most one adapter name — `pewt agents` lists them");
    return argv[0] ? { agent: argv[0] } : {};
  },
  // The name is checked against the roster when the agent is planned
  // (agent.ts), which is the only check that means anything: a name nobody
  // lists is not runnable however well-formed it looks.
  parse: (params) => {
    const agent = (params as Record<string, unknown> | null)?.["agent"];
    if (agent !== undefined && (typeof agent !== "string" || agent === "")) {
      throw new OpError("bad_params", "agent must be an adapter name");
    }
    return { ...(agent !== undefined ? { agent } : {}), ...repoOf(params) };
  },
};

export const cloneProcess: ProcessOperation = {
  method: "repos.clone",
  cli: ["repos", "clone"],
  summary: "clone a repository into repos/",
  usage: "<url> [name]",
  repo: false,
  fromArgv: (argv) => {
    if (argv.length < 1 || argv.length > 2 || !argv[0]) {
      throw new OpError("usage", "repos clone takes a url and, optionally, a project name");
    }
    return { url: argv[0], ...(argv[1] ? { name: argv[1] } : {}) };
  },
  // The url and the name are checked against the disk when the clone is
  // planned (clone.ts), which is the only check that means anything: what a
  // url has to be is "something git can fetch", and git is the authority.
  parse: (params) => {
    const name = (params as Record<string, unknown> | null)?.["name"];
    if (name !== undefined && (typeof name !== "string" || name === "")) {
      throw new OpError("bad_params", "name must be a project name");
    }
    return { url: str(params, "url"), ...(name !== undefined ? { name } : {}) };
  },
};

export const installProcess: ProcessOperation = {
  method: "repos.install",
  cli: ["repos", "install"],
  summary: "npm install in a project — asked first, unlike clone",
  usage: "<name>",
  repo: false,
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "repos install takes one project name — `pewt repos` lists them");
    return { name: argv[0] };
  },
  // The name is checked against the disk when the install is planned
  // (install.ts) — a project that is not there, or has no manifest, is
  // refused before any question is asked.
  parse: (params) => ({ name: str(params, "name") }),
};

export const PROCESSES: ProcessOperation[] = [runProcess, execProcess, shellProcess, agentProcess, cloneProcess, installProcess];

export const processByMethod = (method: string): ProcessOperation | undefined =>
  PROCESSES.find((o) => o.method === method);

/** Every operation's command-line spelling, both families, for `pewt help`. */
export const COMMAND_LIST: { cli: string[]; usage: string; summary: string; repo: boolean }[] = [
  ...OPERATIONS.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: false })),
  ...PROCESSES.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: o.repo })),
];

/** The operation a command line names, and what is left over as arguments.
 *  Longest match wins, so `ext bundle` is found before a future `ext`. */
export function byArgv(argv: string[]): { op: Operation; rest: string[] } | { process: ProcessOperation; rest: string[] } | null {
  const words = (cli: string[]): boolean => cli.every((word, i) => argv[i] === word);
  const op = OPERATIONS.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  const proc = PROCESSES.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  if (op && (!proc || op.cli.length >= proc.cli.length)) return { op, rest: argv.slice(op.cli.length) };
  if (proc) return { process: proc, rest: argv.slice(proc.cli.length) };
  return null;
}
