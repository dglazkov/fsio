// `pewt check` — compile `extensions/` and say what is wrong.
//
// An agent writing an extension has one obvious feedback signal, "render it
// and look", and that one needs you, a browser, and a judgment call. This is
// the second one, and the only one it can run alone (NARRATIVE.md). It is the
// main reason an extension is TypeScript rather than JavaScript.
//
// Three things about it were settled with the owner, and each is a place this
// could reasonably have gone the other way.
//
// **It runs the pewter's own compiler.** `node_modules/typescript`, the one
// `git clone && npm i` restores along with everything else, and the one your
// editor and your CI already use. A compiler this package carried would always
// work and would be free to disagree with the two that matter. A pewter
// without one is refused, by name, with the line that installs it.
//
// **It is answered here, not by the host.** Every other compile in Pewter goes
// through a session — `ext.bundle` is an operation — and this one does not,
// because the moment you most want a typecheck is while writing code, which is
// not a moment with a browser-facing process necessarily up. `pewt check` in a
// git hook, in a scratch pewter, or with the host stopped is the ordinary case
// rather than the exception. The price is that it is the one command with no
// second front end: `pewt.check()` does not exist, because the operation table
// is the host's and this is not on it.
//
// **It starts a process and does not ask.** The host asks before `run`, `shell`
// and `agent` — things that run *your* code, or a shell, or an agent. A
// typechecker reads your extensions and analyzes them; it never executes them,
// which is the same thing `ext.bundle` already does with esbuild and asks
// nothing about. A fourth question here would be prompt fatigue with no scope
// behind it, which is the failure P3 names.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Pewter } from "./pewter.js";

/** One thing the compiler said. `file`, `line` and `column` are absent for a
 *  diagnostic about the project rather than about a place in it — "no inputs
 *  were found" is the one you will actually meet. */
export interface Diagnostic {
  /** relative to the pewter, with forward slashes, exactly as tsc printed it. */
  file?: string;
  line?: number;
  column?: number;
  /** the compiler's own code, `TS2322`. Kept because it is what somebody
   *  searches for, and what an agent can look up without a browser. */
  code: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  errors: Diagnostic[];
  /** the compiler that answered, out of this pewter's own node_modules. */
  version: string;
  ms: number;
}

/** The check could not be run at all — a different thing from the check
 *  finding errors, and the reason those two get different exit codes. */
export class CheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "CheckError";
  }
}

/** Where this pewter's compiler is, and what version it is.
 *
 *  Read out of the package rather than by running `tsc --version`, so a
 *  pewter with no compiler is answered without starting anything. `bin/tsc` is
 *  an ESM entry point with a shebang, so it is run through this process's own
 *  node rather than executed — no dependence on an execute bit, on `.bin`
 *  having been populated, or on anything being found on `PATH`. */
export function compilerIn(p: Pewter): { entry: string; version: string } | null {
  const dir = path.join(p.root, "node_modules", "typescript");
  let pkg: { version?: unknown; bin?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const bin = (pkg.bin as Record<string, unknown> | undefined)?.["tsc"];
  if (typeof bin !== "string") return null;
  const entry = path.join(dir, bin);
  if (!fs.existsSync(entry)) return null;
  return { entry, version: typeof pkg.version === "string" ? pkg.version : "unknown" };
}

/** Compile this pewter's extensions and report what the compiler said.
 *
 *  Nothing is written: `--noEmit` is passed even though the scaffolded
 *  tsconfig already sets it, because a pewter whose tsconfig somebody edited
 *  should still not find JavaScript appearing beside its sources.
 *
 *  `--pretty false` because this parses the output. The colours and the source
 *  excerpts are for a person, and a person reading this is reading what the
 *  renderer below prints. */
export async function check(p: Pewter): Promise<CheckResult> {
  const config = path.join(p.root, "tsconfig.json");
  if (!fs.existsSync(config)) {
    throw new CheckError(
      "no_tsconfig",
      "this pewter has no tsconfig.json, so there is nothing describing how to compile it",
      "a scaffolded pewter has one covering extensions/ — `npm create pewt` writes it"
    );
  }
  if (!fs.existsSync(p.extensions)) {
    throw new CheckError("no_extensions", "this pewter has no extensions/ directory", "an extension is a directory under extensions/ with an index.html and a main.ts");
  }
  const compiler = compilerIn(p);
  if (!compiler) {
    throw new CheckError(
      "no_compiler",
      "this pewter has no typescript installed, so there is nothing to check with",
      // `npm i -D typescript` is the answer and it currently costs you the
      // pewter, so it is not offered on its own. `npm create pewt` installs the
      // compiler before it links, which is why a scaffolded pewter never
      // reaches this message (https://github.com/dglazkov/fsio/issues/181).
      "`pewt check` runs your pewter's own compiler, the same one your editor uses. `npm i -D typescript` installs it — but an `npm install` here also deletes the pewt and pewter links, because they are linked rather than declared, so re-link them afterwards (fsio#181)"
    );
  }

  const t0 = Date.now();
  const { code, out } = await run(compiler.entry, p.root);
  const errors = parse(out);
  // The compiler's exit code is the answer about whether it is happy, and the
  // parsed lines are the answer about why. They can disagree — a diagnostic
  // shape this does not recognize would leave a non-zero code with an empty
  // list — so `ok` follows the exit code, which is the one that cannot be
  // wrong about it.
  return { ok: code === 0, errors, version: compiler.version, ms: Date.now() - t0 };
}

function run(entry: string, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, "--noEmit", "--pretty", "false"],
      // tsc writes one line per diagnostic and a project with a lot wrong
      // produces a lot of them; the default 1 MB would truncate mid-line and
      // this would report fewer errors than there are.
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit is the normal outcome of a failing check, so it
        // arrives here as an error and is not one. What is one is the compiler
        // not starting at all.
        const code = (err as (Error & { code?: unknown }) | null)?.code;
        if (err && typeof code !== "number") return reject(new CheckError("compiler_failed", `the compiler did not run: ${err.message}`));
        resolve({ code: typeof code === "number" ? code : 0, out: `${stdout}${stderr}` });
      }
    );
  });
}

/** `extensions/repos/main.ts(32,7): error TS2322: Type 'number' is not…`
 *
 *  Also the placeless form — `error TS18003: No inputs were found…` — which is
 *  about the project rather than about a line in it. Anything else is left
 *  alone: an unparsed line means the list is short, and `ok` comes from the
 *  exit code rather than from this, so a shape nobody anticipated cannot turn
 *  a failing check into a passing one. */
export function parse(out: string): Diagnostic[] {
  const placed = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  const bare = /^error (TS\d+): (.*)$/;
  const errors: Diagnostic[] = [];
  for (const line of out.split("\n")) {
    const at = placed.exec(line.trimEnd());
    if (at) {
      errors.push({ file: at[1]!, line: Number(at[2]), column: Number(at[3]), code: at[4]!, message: at[5]! });
      continue;
    }
    const any = bare.exec(line.trimEnd());
    if (any) errors.push({ code: any[1]!, message: any[2]! });
  }
  return errors;
}

/** What a terminal prints. `--json` prints the result instead.
 *
 *  Grouped by file, because that is how you fix them: the alternative is a
 *  flat list that repeats a path everybody has already read. */
export function render(result: CheckResult): string {
  if (result.ok) {
    return `extensions/ compiles — nothing to fix.\n  typescript ${result.version}, ${result.ms} ms`;
  }
  const lines: string[] = [];
  let last: string | null = null;
  for (const e of result.errors) {
    const where = e.file ?? "(this project)";
    if (where !== last) {
      lines.push(`\n${where}`);
      last = where;
    }
    const at = e.line !== undefined ? `${e.line}:${e.column}`.padEnd(8) : "".padEnd(8);
    lines.push(`  ${at}${e.code}  ${e.message}`);
  }
  const n = result.errors.length;
  lines.push(`\n${n} error${n === 1 ? "" : "s"} — typescript ${result.version}, ${result.ms} ms`);
  // The compiler said no and this said nothing about why, which is a bug in
  // the parser above rather than in the extension. Say so, instead of printing
  // a confident "0 errors" beside a failing exit code.
  if (n === 0) lines.push("(the compiler refused and this could not read its output — run `npx tsc --noEmit` here to see it)");
  return lines.join("\n").trimStart();
}
