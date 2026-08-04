// argv → an operation, or a reason it isn't one.
//
// Separate from cli.ts so the parsing is testable without a process: every
// exit code below is reachable from a unit test, and none of them needs a
// folder.
import type { Operation } from "./model.js";

export const USAGE = `actuator — drive the fsio actuator demo page from this machine

USAGE
  actuator [--dir <folder>] [--json] <command>

COMMANDS
  tabs add --title <text> --message <text> [--no-activate]
  tabs remove <tab-id>
  tabs activate <tab-id>
  tabs update <tab-id> [--title <text>] [--message <text>]
  tabs list

OPTIONS
  --dir <folder>   the folder the page was granted (default: this one)
  --json           print the page's answer as JSON

The page must be open on that folder, and the helper running in it. A
command is applied by the page, in the browser, to state the page owns —
nothing here writes application state.

EXAMPLES
  actuator tabs add --title Build --message "CI is running"
  actuator tabs list --json
  actuator tabs update tab-8f2a --message "CI passed"`;

export type Parsed =
  | { kind: "run"; op: Operation; dir: string; json: boolean }
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

export function parseArgs(input: string[], cwd: string): Parsed {
  const argv = [...input];
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", text: USAGE };
  }

  const json = takeFlag(argv, "--json");
  const dirValue = takeValue(argv, "--dir");
  if (dirValue === null) return { kind: "error", message: "--dir needs a folder" };
  const dir = dirValue ?? cwd;

  if (argv[0] !== "tabs") return { kind: "error", message: `unknown command ${JSON.stringify(argv[0])}` };
  const action = argv[1];
  const rest = argv.slice(2);
  const done = (op: Operation): Parsed => {
    const stray = rest.find((a) => a.startsWith("--"));
    if (stray) return { kind: "error", message: `unknown option ${stray}` };
    return { kind: "run", op, dir, json };
  };

  switch (action) {
    case "add": {
      const title = takeValue(rest, "--title");
      const message = takeValue(rest, "--message");
      const noActivate = takeFlag(rest, "--no-activate");
      if (title === undefined || title === null) return { kind: "error", message: "tabs add needs --title <text>" };
      if (message === undefined || message === null) return { kind: "error", message: "tabs add needs --message <text>" };
      return done({ method: "tabs.add", params: { title, message, activate: !noActivate } });
    }
    case "remove":
    case "activate": {
      const id = rest.shift();
      if (!id || id.startsWith("--")) return { kind: "error", message: `tabs ${action} needs a tab id` };
      return done({ method: action === "remove" ? "tabs.remove" : "tabs.activate", params: { id } });
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
      return done({
        method: "tabs.update",
        params: { id, ...(title !== undefined ? { title } : {}), ...(message !== undefined ? { message } : {}) },
      });
    }
    case "list":
      return done({ method: "tabs.list", params: {} });
    default:
      return { kind: "error", message: `unknown tabs action ${JSON.stringify(action ?? "")}` };
  }
}
