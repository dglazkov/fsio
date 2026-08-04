// argv → an operation, or a reason it isn't one.
//
// Separate from cli.ts so the parsing is testable without a process: every
// exit code below is reachable from a unit test, and none of them needs a
// folder.
//
// One command does not come out of here as an operation. `fling` has to
// read a file before it can say what it is sending, and reading is cli.ts's
// business — so it parses to a `fling` intent and is hydrated there. The
// alternative, an operation with a hole in it, would put a half-built
// message in the type that every other path treats as complete.
import path from "node:path";
import { safeRelPath, type Operation } from "./model.js";

export const USAGE = `actuator — drive the fsio actuator demo page from this machine

USAGE
  actuator [--dir <folder>] [--json] <command>

TABS
  tabs add --title <text> --message <text> [--no-activate]
  tabs remove <tab-id>
  tabs activate <tab-id>
  tabs update <tab-id> [--title <text>] [--message <text>]
  tabs list

FILES
  open <path>               show a file from the granted folder — the page
                            reads it where it lies, and nothing moves
  fling <path> [--no-open]  hand the page a copy of any file this terminal
                            can read. It lands in the browser's own storage
                            and stays there without the folder or the helper
  files list                what the page is holding
  files show <file-id>      put a held copy in a tab
  files drop <file-id>      let go of one

OPTIONS
  --dir <folder>   the folder the page was granted (default: this one)
  --json           print the page's answer as JSON

The page must be open on that folder, and the helper running in it. A
command is applied by the page, in the browser, to state the page owns —
nothing here writes application state.

EXAMPLES
  actuator tabs add --title Build --message "CI is running"
  actuator open notes/plan.md
  actuator fling ~/Pictures/graph.png
  actuator files list --json`;

export type Parsed =
  | { kind: "run"; op: Operation; dir: string; json: boolean }
  /** `fling`: the file still has to be read. cli.ts finishes this one. */
  | { kind: "fling"; path: string; open: boolean; dir: string; json: boolean }
  | { kind: "help"; text: string }
  | { kind: "error"; message: string };

/** A flag's value, removed from the list. Returns undefined when absent;
 *  the caller decides whether that is fatal. */
function takeValue(argv: string[], name: string): string | undefined | null {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) return null; // present, no value
  argv.splice(i, 2);
  return value;
}

function takeFlag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

/** No stray flags left over — a mistyped option must never be swallowed by
 *  a command that ignores what it does not recognize. */
const rejectStray = (rest: string[]): Parsed | null => {
  const stray = rest.find((a) => a.startsWith("--"));
  return stray ? { kind: "error", message: `unknown option ${stray}` } : null;
};

export function parseArgs(input: string[], cwd: string): Parsed {
  const argv = [...input];
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", text: USAGE };
  }

  const json = takeFlag(argv, "--json");
  const dirValue = takeValue(argv, "--dir");
  if (dirValue === null) return { kind: "error", message: "--dir needs a folder" };
  const dir = dirValue ?? cwd;

  const verb = argv[0];
  const rest = argv.slice(1);
  const run = (op: Operation): Parsed => rejectStray(rest) ?? { kind: "run", op, dir, json };

  switch (verb) {
    case "tabs":
      return tabs(rest, dir, json);
    case "files":
      return files(rest, dir, json);

    case "open": {
      const typed = rest.shift();
      if (!typed || typed.startsWith("--")) return { kind: "error", message: "open needs a path" };
      // What travels is the path *relative to the granted folder*, because
      // that is the only frame of reference the page has: it holds one
      // directory handle and can resolve names under it and nowhere else.
      // Doing the arithmetic here means a path outside the folder is
      // refused in the terminal that typed it, with the folder named and
      // the other verb offered, rather than coming back as a refusal from
      // a page that never had a chance.
      //
      // A relative path is relative to that folder too, not to the shell's
      // cwd — `--dir` names the subject of the command, the way `git -C`
      // does. Without `--dir` the two are the same directory and the
      // question does not arise; with it, resolving against cwd made
      // `--dir ~/demo open notes/plan.md` fail from anywhere but ~/demo,
      // which is how this was found (the first real run of it).
      const root = path.resolve(cwd, dir);
      const rel = path.relative(root, path.resolve(root, typed)).split(path.sep).join("/");
      const safe = safeRelPath(rel);
      if (!safe) {
        return {
          kind: "error",
          message:
            `${typed} is not inside ${root}\n` +
            "  The page can only look inside the folder you granted it.\n" +
            `  To hand it a copy instead:  actuator fling ${typed}`,
        };
      }
      return run({ method: "files.open", params: { path: safe } });
    }

    case "fling": {
      const noOpen = takeFlag(rest, "--no-open");
      const typed = rest.shift();
      if (!typed || typed.startsWith("--")) return { kind: "error", message: "fling needs a path" };
      return rejectStray(rest) ?? { kind: "fling", path: path.resolve(cwd, typed), open: !noOpen, dir, json };
    }

    default:
      return { kind: "error", message: `unknown command ${JSON.stringify(verb)}` };
  }
}

function tabs(rest: string[], dir: string, json: boolean): Parsed {
  const action = rest.shift();
  const run = (op: Operation): Parsed => rejectStray(rest) ?? { kind: "run", op, dir, json };

  switch (action) {
    case "add": {
      const title = takeValue(rest, "--title");
      const message = takeValue(rest, "--message");
      const noActivate = takeFlag(rest, "--no-activate");
      if (title === undefined || title === null) return { kind: "error", message: "tabs add needs --title <text>" };
      if (message === undefined || message === null) return { kind: "error", message: "tabs add needs --message <text>" };
      return run({ method: "tabs.add", params: { title, message, activate: !noActivate } });
    }
    case "remove":
    case "activate": {
      const id = rest.shift();
      if (!id || id.startsWith("--")) return { kind: "error", message: `tabs ${action} needs a tab id` };
      return run({ method: action === "remove" ? "tabs.remove" : "tabs.activate", params: { id } });
    }
    case "update": {
      const id = rest.shift();
      if (!id || id.startsWith("--")) return { kind: "error", message: "tabs update needs a tab id" };
      const title = takeValue(rest, "--title");
      const message = takeValue(rest, "--message");
      if (title === null || message === null) return { kind: "error", message: "--title and --message need values" };
      if (title === undefined && message === undefined) {
        return { kind: "error", message: "tabs update needs --title or --message" };
      }
      return run({
        method: "tabs.update",
        params: { id, ...(title !== undefined ? { title } : {}), ...(message !== undefined ? { message } : {}) },
      });
    }
    case "list":
      return run({ method: "tabs.list", params: {} });
    default:
      return { kind: "error", message: `unknown tabs action ${JSON.stringify(action ?? "")}` };
  }
}

function files(rest: string[], dir: string, json: boolean): Parsed {
  const action = rest.shift();
  const run = (op: Operation): Parsed => rejectStray(rest) ?? { kind: "run", op, dir, json };

  switch (action) {
    case "list":
      return run({ method: "files.list", params: {} });
    case "show":
    case "drop": {
      const id = rest.shift();
      if (!id || id.startsWith("--")) return { kind: "error", message: `files ${action} needs a file id` };
      return run({ method: action === "show" ? "files.show" : "files.drop", params: { id } });
    }
    default:
      return { kind: "error", message: `unknown files action ${JSON.stringify(action ?? "")}` };
  }
}
