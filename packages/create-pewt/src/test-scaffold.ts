// What a new pewter is, checked against what the host expects to find.
//
// The scaffolder and `@fsio/pewt` have to agree about the folder or a fresh
// pewter opens to an error: the `pewter` field the host walks up looking
// for, the extension layout the bundler compiles, and the four things
// .gitignore sorts by what deletes them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { link, NotEmpty, scaffold } from "./scaffold.js";

/** This checkout: two levels up from dist/ is the package, four is the repo. */
const repo = path.resolve(import.meta.dirname, "../../..");

const into = (): string => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "create-pewt-"));
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

test("a new pewter is a pewter — the host can find it", () => {
  const root = path.join(into(), "tinkering");
  scaffold({ root, link: "/somewhere/fsio" });
  const pkg = JSON.parse(read(root, "package.json"));
  // The one field `findPewter` looks for. Without it the folder is an
  // ordinary npm project and `pewt` refuses to run in it.
  assert.ok(pkg.pewter);
  assert.equal(pkg.name, "tinkering");
  assert.equal(pkg.scripts.start, "pewt serve");
  assert.equal(pkg.scripts.check, "pewt check");
  // The compiler `pewt check` runs, declared rather than carried by `pewt`,
  // so `git clone && npm i` restores the checker with everything else and
  // your editor and the command agree about which one is in use.
  assert.equal(pkg.devDependencies.typescript, "^7.0.2");
  // Still no runtime dependencies, and that is deliberate: `pewt` and
  // `pewter` are linked into node_modules until they publish, because a
  // dependency npm cannot install would be worse than none in a file
  // somebody commits (https://github.com/dglazkov/fsio/issues/181).
  assert.equal(pkg.dependencies, undefined);
});

test("linking puts pewt where `npm start` looks for it", () => {
  const root = path.join(into(), "p");
  scaffold({ root, link: repo });
  const linked = link(root, repo);
  assert.ok(linked.includes("node_modules/.bin/pewt"));
  // `npm start` runs `pewt serve`, which npm resolves through node_modules/.bin.
  const shim = path.join(root, "node_modules/.bin/pewt");
  assert.ok(fs.existsSync(shim), "the bin shim resolves");
  // And an extension's `import { pewt } from "pewter"` has something to find.
  assert.ok(fs.existsSync(path.join(root, "node_modules/pewter/dist/index.js")));
});

test("linking an unbuilt checkout says so instead of producing a broken pewter", () => {
  const root = path.join(into(), "p");
  scaffold({ root, link: "/nowhere" });
  assert.throws(() => link(root, path.join(into(), "empty-checkout")), /has not been built/);
});

test("it ships one extension, in the shape the bundler compiles", () => {
  const root = path.join(into(), "p");
  scaffold({ root, link: "/somewhere/fsio" });
  // `bundleExtension` needs exactly these two names.
  assert.ok(fs.existsSync(path.join(root, "extensions/repos/index.html")));
  assert.ok(fs.existsSync(path.join(root, "extensions/repos/main.ts")));
  // The first screen is an ordinary extension calling the ordinary API. If
  // it reached for anything private, "there are no built-ins" would be a
  // claim rather than a demonstration.
  const main = read(root, "extensions/repos/main.ts");
  assert.match(main, /import \{ pewt \} from "pewter"/);
  assert.match(main, /pewt\.repos\.list\(\)/);
});

test("everything sorts by what deletes it", () => {
  const root = path.join(into(), "p");
  scaffold({ root, link: "/somewhere/fsio" });
  const ignored = read(root, ".gitignore");
  // Your work is not committed, which is what lets a pewter be pushed
  // somewhere public.
  assert.match(ignored, /^repos\/$/m);
  // Regenerated: the channel and this pewter's own state.
  assert.match(ignored, /^\.fsio\/$/m);
  assert.match(ignored, /^\.pewter\/$/m);
  // Committed: the pewter itself. Absent from the ignore file on purpose.
  for (const kept of ["AGENTS.md", "package.json", "tsconfig.json", "extensions/"]) {
    assert.doesNotMatch(ignored, new RegExp(`^${kept.replace(".", "\\.")}$`, "m"));
  }
  assert.ok(fs.statSync(path.join(root, "repos")).isDirectory(), "repos/ exists on disk though it is never in history");
});

test("tsconfig covers extensions/, which is what `pewt check` compiles", () => {
  const root = path.join(into(), "p");
  scaffold({ root, link: "/somewhere/fsio" });
  assert.deepEqual(JSON.parse(read(root, "tsconfig.json")).include, ["extensions"]);
});

test("a folder with things in it is a merge, not a start", () => {
  const root = into();
  fs.writeFileSync(path.join(root, "notes.md"), "mine");
  assert.throws(() => scaffold({ root, link: "/somewhere/fsio" }), (e: unknown) => e instanceof NotEmpty);
});

test("a folder that does not exist yet is fine", () => {
  const root = path.join(into(), "deep", "nested", "pewter");
  assert.deepEqual(scaffold({ root, link: "/x" }).includes("package.json"), true);
});
