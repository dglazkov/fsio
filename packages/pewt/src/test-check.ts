// `pewt check`, against a real compiler.
//
// The compiler is this repository's own `typescript`, linked into a temporary
// pewter the way `npm i -D typescript` would leave it. That is not a shortcut
// around the lookup under test — it is the lookup's actual rule, which is "is
// there a `node_modules/typescript` in this pewter". Nothing here needs a
// host, a browser or a network, which is the property `check` exists to have.
//
// Every test that compiles spawns tsc, so there are deliberately few of them:
// one per claim the command makes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { check, CheckError, compilerIn, parse, render } from "./check.js";
import { pewterAt, type Pewter } from "./pewter.js";

/** This checkout's own typescript, which every pewter below borrows. */
const TYPESCRIPT = path.resolve(import.meta.dirname, "../../../node_modules/typescript");

/** The tsconfig `create-pewt` writes, which is the one `check` runs against.
 *  Copied rather than imported: the scaffolder is a different package, and a
 *  test that imported it would be measuring two things. */
const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["extensions"],
};

interface Opts {
  /** the extension's main.ts. Omit for one that compiles. */
  source?: string;
  /** leave typescript out, the way a hand-made pewter would. */
  compiler?: boolean;
  /** leave tsconfig.json out. */
  config?: boolean;
}

function pewter(opts: Opts, fn: (p: Pewter) => Promise<void> | void): Promise<void> | void {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-check-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  if (opts.config !== false) fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify(TSCONFIG));
  const ext = path.join(root, "extensions", "one");
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, "main.ts"), opts.source ?? 'const greeting: string = "hello";\nexport default greeting;\n');
  if (opts.compiler !== false) {
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(TYPESCRIPT, path.join(root, "node_modules", "typescript"), "dir");
  }
  const done = fn(pewterAt(root)!);
  const clean = (): void => fs.rmSync(root, { recursive: true, force: true });
  if (done instanceof Promise) return done.finally(clean);
  clean();
  return undefined;
}

test("an extension that compiles reports nothing, and names the compiler that said so", async () => {
  await pewter({}, async (p) => {
    const result = await check(p);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    // The version is read off the pewter's own package rather than by asking
    // tsc, which is what lets a pewter with no compiler be answered without
    // starting one.
    assert.match(result.version, /^\d+\./);
    assert.match(render(result), /compiles — nothing to fix/);
  });
});

test("a type error comes back with its place, its code and its words", async () => {
  await pewter({ source: 'const n: string = 42;\nexport default n;\n' }, async (p) => {
    const result = await check(p);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [e] = result.errors;
    // Pewter-relative and with forward slashes: what a person can paste into
    // an editor, and what an agent can act on without knowing where the
    // folder is.
    assert.equal(e!.file, "extensions/one/main.ts");
    assert.equal(e!.line, 1);
    assert.equal(e!.code, "TS2322");
    assert.match(e!.message, /not assignable/);
    assert.match(render(result), /1 error/);
  });
});

test("nothing is written beside the sources, whatever the tsconfig says", async () => {
  // `--noEmit` is passed as well as configured. A pewter whose tsconfig
  // somebody edited should still not find JavaScript appearing in
  // extensions/ because they ran a typecheck.
  await pewter({}, async (p) => {
    const config = path.join(p.root, "tsconfig.json");
    const edited = JSON.parse(fs.readFileSync(config, "utf8"));
    delete edited.compilerOptions.noEmit;
    fs.writeFileSync(config, JSON.stringify(edited));
    await check(p);
    assert.deepEqual(fs.readdirSync(path.join(p.extensions, "one")), ["main.ts"]);
  });
});

test("a pewter with no compiler is refused, and the refusal names the one that installs it", () => {
  return pewter({ compiler: false }, async (p) => {
    assert.equal(compilerIn(p), null);
    await assert.rejects(
      () => check(p),
      (e: unknown) => e instanceof CheckError && e.code === "no_compiler" && /npm i -D typescript/.test(e.hint ?? "")
    );
  });
});

test("a pewter with no tsconfig is refused before anything is started", () => {
  return pewter({ config: false }, async (p) => {
    await assert.rejects(
      () => check(p),
      (e: unknown) => e instanceof CheckError && e.code === "no_tsconfig"
    );
  });
});

test("the compiler's placeless diagnostics are read too", () => {
  // `error TS18003: No inputs were found` has no file and no line, and it is
  // the one a person meets first — an extensions/ directory with nothing in
  // it yet. A parser that only knew the placed form would report a failing
  // check with zero errors in it.
  const errors = parse(
    [
      "extensions/one/main.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "error TS18003: No inputs were found in config file 'tsconfig.json'.",
      "some line nobody anticipated",
      "",
    ].join("\n")
  );
  assert.deepEqual(errors, [
    { file: "extensions/one/main.ts", line: 1, column: 7, code: "TS2322", message: "Type 'number' is not assignable to type 'string'." },
    { code: "TS18003", message: "No inputs were found in config file 'tsconfig.json'." },
  ]);
});

test("a refusal this cannot read still reads as a refusal", () => {
  // `ok` comes from the exit code and never from the parsed list, so a
  // diagnostic shape nobody anticipated makes the output short rather than
  // making a failing check look clean. The renderer says so out loud.
  assert.match(render({ ok: false, errors: [], version: "7.0.2", ms: 3 }), /could not read its output/);
});
