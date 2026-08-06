// argv → what to do. Separate from cli.ts so it is testable without a
// folder, a host, or a process to exit.
import { byArgv, COMMAND_LIST } from "./ops.js";

export type Parsed =
  | { kind: "help"; text: string }
  | { kind: "error"; message: string }
  | { kind: "serve"; dir: string | null; url: string | null; open: boolean; allowRuns: boolean; allowShells: boolean; allowAgents: boolean }
  | { kind: "check"; dir: string | null; json: boolean }
  | { kind: "op"; dir: string | null; json: boolean; method: string; params: unknown }
  | { kind: "process"; dir: string | null; json: boolean; dryRun: boolean; method: string; spec: Record<string, unknown> };

// Two commands are not operations, so they are written here and everything
// else comes off the table. `serve` is the host rather than a call on one.
// `check` is answered on this side of the folder and needs no host at all
// (check.ts) — the one command with a single front end.
//
// One column width for all of them, computed rather than typed, because a
// hand-aligned column is wrong the first time an operation with a longer name
// arrives.
const COMMANDS: [string, string][] = [
  ["serve", "run the host for this pewter"],
  ["check", "compile extensions/ and say what is wrong"],
  ...COMMAND_LIST.map((c): [string, string] => [[...c.cli, c.usage].filter(Boolean).join(" "), c.summary]),
];
const WIDTH = Math.max(...COMMANDS.map(([spelling]) => spelling.length)) + 2;

const USAGE = `pewt — the command line for a pewter

${COMMANDS.map(([spelling, summary]) => `  pewt ${spelling.padEnd(WIDTH)}${summary}`).join("\n")}

Anywhere:
  --dir <path>   act on the pewter at <path> instead of the one containing
                 the working directory (a development convenience)
  --json         print the result as JSON instead of prose
  --help         this

run, shell, agent:
  --repo <name>  a project under repos/ (default: the pewter itself)
  --dry-run      print what would start, and start nothing

serve:
  --url <base>   where the shell is served from
  --no-open      print the URL and open nothing
  --allow-runs   allow every \`run\` without asking on this terminal
  --allow-shells allow every \`shell\` without asking on this terminal
  --allow-agents allow every \`agent\` without asking on this terminal

The allow flags are separate because these are separate capabilities:
something that was told it could build is not thereby something that can do
anything, or something that can run a coding agent on your projects.

Answering a host's question with \`a\` records a standing grant in
.pewter/grants.json, and questions of that shape are not asked again. A grant
is narrower than any flag: a run's covers one project, an agent's covers one
adapter in one project, and a shell gets none at all — it is unconfined, so an
\`always\` there would be \`always, anything\`. \`pewt grants\` lists them and
\`pewt grants revoke <id>\` takes one back, which the next question feels.

The file is in .pewter/, which a pewter git-ignores, so a grant does not
travel with a clone. It does travel to a host with no terminal: a background
\`pewt serve\` cannot ask, but it can still honour what you already answered.

\`pewt agent\` is a pipe, not a conversation: one ACP message per line in on
stdin, the agent's own messages out on stdout. Whatever is on the other end
is the ACP client — a tab is the one Pewter ships toward.

\`pewt tabs\`, \`pewt files\`, \`open\` and \`fling\` are answered by the page rather
than by the host: a tab is not on disk anywhere and a flung copy is in the
browser's storage, so the host forwards these down the session the shell holds.
They need a page open, which is what exit 4 says.

open, fling:
  <path> is relative to the pewter, and inside it. The page reads it through
  the grant it already holds, so nothing rides the wire and there is no size
  limit — the browser's storage quota is the only one. \`open\` is a window on
  the file and follows it; \`fling\` is a copy the page owns and keeps working
  when the file, the host and the grant are all gone.

\`pewt check\` compiles \`extensions/\` with this pewter's own TypeScript — the
same compiler your editor and your CI use, out of your own node_modules. It is
the one command with no host in it: the moment you want a typecheck is while
you are writing, which is not necessarily a moment with a host up, so it reads
the disk here and answers here. That is also why there is no \`pewt.check()\`
for an extension to call.

It starts a process and does not ask, unlike \`run\`, \`shell\` and \`agent\`. A
typechecker reads your extensions and never runs them, which is what \`ext
bundle\` already does.

Exit codes: 0 done · 1 refused · 2 usage · 3 no host is running · 4 no page is
open. The last two are separate because they are separate things to do: start
the host, or open the shell and hand it this folder.
\`pewt check\` uses the first three differently: 0 is clean, 1 is errors found,
and 2 is could not check at all — no compiler, no tsconfig — because a git
hook wants "your code is wrong" and "this pewter is not set up" to be two
things.
\`pewt run\` exits with the script's own code instead, the way \`npm run\` does —
so a script that exits 3 and a pewter with no host look alike, and the message
on stderr is what tells them apart.`;

export function parseArgs(argv: string[]): Parsed {
  let dir: string | null = null;
  let url: string | null = null;
  let repo: string | null = null;
  let json = false;
  let open = true;
  let dryRun = false;
  let allowRuns = false;
  let allowShells = false;
  let allowAgents = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "help") return { kind: "help", text: USAGE };
    else if (a === "--json") json = true;
    else if (a === "--no-open") open = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-runs") allowRuns = true;
    else if (a === "--allow-shells") allowShells = true;
    else if (a === "--allow-agents") allowAgents = true;
    else if (a === "--dir" || a === "--url" || a === "--repo") {
      const value = argv[++i];
      if (!value) return { kind: "error", message: `${a} needs a value` };
      if (a === "--dir") dir = value;
      else if (a === "--url") url = value;
      else repo = value;
    } else if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a.startsWith("--repo=")) repo = a.slice("--repo=".length);
    else if (a.startsWith("-")) return { kind: "error", message: `unknown flag ${a}` };
    else rest.push(a);
  }

  if (rest.length === 0) return { kind: "help", text: USAGE };
  if (rest[0] === "serve") {
    if (rest.length > 1) return { kind: "error", message: `serve takes no arguments (got ${rest.slice(1).join(" ")})` };
    return { kind: "serve", dir, url, open, allowRuns, allowShells, allowAgents };
  }
  if (rest[0] === "check") {
    if (rest.length > 1) return { kind: "error", message: `check takes no arguments (got ${rest.slice(1).join(" ")}) — it compiles all of extensions/` };
    return { kind: "check", dir, json };
  }

  const found = byArgv(rest);
  if (!found) return { kind: "error", message: `unknown command ${JSON.stringify(rest.join(" "))}` };
  try {
    if ("process" in found) {
      if (repo !== null && !found.process.repo) return { kind: "error", message: `${found.process.cli.join(" ")} takes no --repo` };
      return {
        kind: "process",
        dir,
        json,
        dryRun,
        method: found.process.method,
        // Through `parse`, not around it: what the command line typed and
        // what an extension passed become one spec in one place, and a
        // front end that skipped it would be inventing a second wire format.
        spec: found.process.parse({ ...found.process.fromArgv(found.rest), ...(repo !== null ? { repo } : {}) }),
      };
    }
    // A flag that means nothing here is a typo, not a preference: `pewt repos
    // --repo site` is somebody expecting a filter that does not exist, and
    // ignoring it would answer a different question than the one asked.
    if (repo !== null) return { kind: "error", message: `${found.op.cli.join(" ")} takes no --repo` };
    if (dryRun) return { kind: "error", message: `${found.op.cli.join(" ")} starts nothing, so --dry-run has nothing to describe` };
    return { kind: "op", dir, json, method: found.op.method, params: found.op.fromArgv(found.rest) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
