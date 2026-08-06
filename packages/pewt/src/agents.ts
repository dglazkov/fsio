// Which agents this pewter can run, and how it knows.
//
// The answer is your own `package.json`. An ACP adapter is an ordinary
// dependency — `npm i @agentclientprotocol/claude-agent-acp` — so it is
// pinned in your lockfile, `npm rm` removes it, and `git clone && npm i`
// brings it back on another machine along with the rest of your pewter.
// Nothing installs globally and nothing hides in your home directory.
//
// That is the one place this differs from `acp-demo`, which it otherwise
// harvests: there an adapter is found on `PATH`, or offered and installed
// into `~/.fsio/agents/<name>` after a `y` on a terminal. None of that comes
// across. The set of runnable agents is a file, which is the same sentence
// `run` earns for scripts (run.ts) — and the file is one npm already owns.
//
// **Why a table at all, when `run` needs none.** A script is a line somebody
// wrote, so a `package.json` can name anything. An adapter has to carry a
// binary name and a measured answer to "does it ask before it edits", and
// neither is derivable from a dependency. So the names below are the roster,
// an adapter nobody has listed is not listed, and nothing from the wire ever
// becomes a path (#6, P3).
import fs from "node:fs";
import path from "node:path";
import type { Pewter } from "./pewter.js";

/** One adapter this build knows how to run. */
export interface Adapter {
  /** the name a page or a terminal may ask for. */
  name: string;
  /** the npm package that provides it. */
  pkg: string;
  /** the executable npm links into `node_modules/.bin`. Never from the wire. */
  bin: string;
  /** one human-facing line. */
  title: string;
  /** Does it send `session/request_permission` before it changes a file?
   *
   *  **Measured by `acp-demo`, cited here rather than re-asserted**, and the
   *  reason the roster exists at all: a person choosing between two agents is
   *  choosing whether anything will ask them before a file changes.
   *
   *  The measurement is about one version, which is why `measured` is beside
   *  it. A pewter installs whatever its lockfile says, and this column
   *  describing different software than the one running is worse than no
   *  column — `roster()` says so when the two differ. */
  asks: boolean;
  /** the version `asks` was measured against. */
  measured: string;
}

/** What this build knows. Two entries, because two are what anybody has
 *  measured; adding a third means measuring `asks` first. */
export const ADAPTERS: Adapter[] = [
  {
    name: "claude-agent-acp",
    pkg: "@agentclientprotocol/claude-agent-acp",
    bin: "claude-agent-acp",
    title: "Claude Code (ACP adapter)",
    // F30, measured by acp-demo at 0.64.0: it asks, and the client renders
    // the question. Caveat the roster cannot carry: only in manual permission
    // mode, which comes from the operator's own Claude Code configuration.
    asks: true,
    measured: "0.64.0",
  },
  {
    name: "pi-acp",
    pkg: "pi-acp",
    bin: "pi-acp",
    title: "pi coding agent (ACP adapter)",
    // https://github.com/dglazkov/fsio/issues/100, measured by acp-demo at
    // 0.0.32: zero `session/request_permission` and zero `fs/*` across a
    // driven session, because it reads and edits with its own hands.
    asks: false,
    measured: "0.0.32",
  },
];

/** One roster line, as a terminal and a page both see it.
 *
 *  Prose, names and versions only. No paths: this answers an operation any
 *  extension can call, and where a binary lives is not something a tab needs
 *  to know to use it. */
export interface RosterEntry {
  name: string;
  title: string;
  /** the npm package to install, and what to type to get it. */
  pkg: string;
  install: string;
  /** is it a dependency of this pewter with its binary actually linked? */
  installed: boolean;
  /** the version in this pewter's `node_modules`, or null when absent. */
  version: string | null;
  asks: boolean;
  /** the version `asks` was measured against. */
  measured: string;
  /** true when the installed version is not the measured one — `asks` is then
   *  a claim about a different build, and saying so is cheaper than being
   *  quietly wrong about whether anything will ask before a file changes. */
  unmeasured: boolean;
}

export const installLine = (a: Adapter): string => `npm i ${a.pkg}`;

/** What this pewter can actually run, right now.
 *
 *  Cheap: two `stat`s per entry. Every adapter is listed whether or not it is
 *  here, because an empty list and "you have none of these" are different
 *  answers and only one of them tells you what to do next. */
export function roster(p: Pewter): RosterEntry[] {
  return ADAPTERS.map((a) => {
    const found = resolve(p, a);
    return {
      name: a.name,
      title: a.title,
      pkg: a.pkg,
      install: installLine(a),
      installed: found !== null,
      version: found?.version ?? null,
      asks: a.asks,
      measured: a.measured,
      unmeasured: found !== null && found.version !== a.measured,
    };
  });
}

/** An adapter by name, or null. Callers turn null into a refusal. */
export const findAdapter = (name: unknown): Adapter | null =>
  typeof name === "string" ? ADAPTERS.find((a) => a.name === name) ?? null : null;

/** Is this adapter installed in this pewter, and at what version?
 *
 *  Both halves are checked, because either alone lies. A `package.json`
 *  entry with no `node_modules` is a pewter somebody has not run `npm i` in
 *  yet; a binary with no package is a leftover. What runs is the binary, so
 *  it is the one that decides, and the version comes off the package beside
 *  it. */
export function resolve(p: Pewter, adapter: Adapter): { bin: string; version: string | null } | null {
  const bin = path.join(p.root, "node_modules", ".bin", adapter.bin);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return null;
  }
  return { bin, version: versionOf(p, adapter) };
}

function versionOf(p: Pewter, adapter: Adapter): string | null {
  try {
    const manifest = path.join(p.root, "node_modules", ...adapter.pkg.split("/"), "package.json");
    const version = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    // A binary whose package cannot be read still runs. Reporting the version
    // as unknown beats refusing to list an agent that is plainly there.
    return null;
  }
}
