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
import { dependencies, NotEmpty, scaffold } from "./scaffold.js";

/** This checkout: two levels up from dist/ is the package, four is the repo. */
const repo = path.resolve(import.meta.dirname, "../../..");

const into = (): string => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "create-pewt-"));
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

test("a new pewter is a pewter — the host can find it", () => {
  const root = path.join(into(), "tinkering");
  scaffold({ root });
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
});

// The regression this file exists for now (#181). These two were bare
// symlinks that `package.json` deliberately did not mention, npm prunes
// whatever no dependency declares, and so the first `npm install` of
// anything deleted them — including the `npm i <adapter>` that `pewt agents`
// itself tells you to run. Declared is the entire fix, and it is a property
// of the written file rather than of anything that runs, so it is checkable
// here with no network and no npm.
test("pewt and pewter are declared, which is what stops npm pruning them", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  const pkg = JSON.parse(read(root, "package.json"));
  assert.equal(pkg.dependencies.pewt, "github:dglazkov/fsio#pewt");
  assert.equal(pkg.dependencies.pewter, "github:dglazkov/fsio#pewter");
});

test("--link spells them as relative file: paths, with no home directory in them", () => {
  const root = path.join(into(), "p");
  scaffold({ root, source: { kind: "checkout", path: repo } });
  const pkg = JSON.parse(read(root, "package.json"));
  for (const name of ["pewt", "pewter"]) {
    const spec = pkg.dependencies[name];
    assert.match(spec, /^file:\.\./, `${name} is relative`);
    // The cost the old comment worried about, and the reason this is
    // relative: this file goes into a git repository, and an absolute path
    // would carry somebody's home directory into it.
    assert.doesNotMatch(spec, /^file:\//, `${name} carries no absolute path`);
    // It still has to point at the real thing.
    assert.equal(path.resolve(root, spec.slice("file:".length)), path.join(repo, "packages", name));
  }
});

test("both spellings name the directory node_modules will hold", () => {
  // The key is what npm installs under, whatever the package on the other
  // end calls itself — which is why an extension's `import … from "pewter"`
  // resolves with no registry name anywhere in the story.
  for (const source of [{ kind: "git" } as const, { kind: "checkout", path: repo } as const]) {
    assert.deepEqual(Object.keys(dependencies("/p", source)).sort(), ["pewt", "pewter"]);
  }
});

test("it ships three extensions, in the shape the bundler compiles", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // `bundleExtension` needs exactly these two names, per extension.
  for (const ext of ["repos", "terminal", "agent"]) {
    assert.ok(fs.existsSync(path.join(root, `extensions/${ext}/index.html`)));
    assert.ok(fs.existsSync(path.join(root, `extensions/${ext}/main.ts`)));
  }
  // The first screen is an ordinary extension calling the ordinary API. If
  // it reached for anything private, "there are no built-ins" would be a
  // claim rather than a demonstration.
  const main = read(root, "extensions/repos/main.ts");
  assert.match(main, /import \{ pewt, PewtError \} from "pewter"/);
  assert.match(main, /pewt\.repos\.list\(\)/);
});

test("the terminal's emulator is the pewter's own dependency, not the shell's", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // NARRATIVE.md's claim, checkable as a property of the written files:
  // nothing about the terminal is built into the shell. The extension
  // imports an emulator, and the emulator is a line in this package.json —
  // the ACP-adapter arrangement, so `npm rm` and `git clone && npm i` both
  // mean what they always mean.
  const pkg = JSON.parse(read(root, "package.json"));
  assert.ok(pkg.dependencies["@xterm/xterm"]);
  assert.ok(pkg.dependencies["@xterm/addon-fit"]);
  const main = read(root, "extensions/terminal/main.ts");
  assert.match(main, /import \{ Terminal \} from "@xterm\/xterm"/);
  assert.match(main, /pewt\.shell\(/);
  // Self-sufficient (#195): opened bare, where the shell starts is this
  // screen's own question, asked of the same list every front end reads.
  assert.match(main, /pewt\.repos\.list\(\)/);
});

test("the repos rows and the terminal agree about the shell verb (#198)", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The two ends of one argument: the row sends `{repo}`, the terminal
  // reads it and skips its picker. The page between them carries it unread,
  // so this agreement — the whole contract — lives in these two files.
  const repos = read(root, "extensions/repos/main.ts");
  assert.match(repos, /pewt\.tabs\.add\(\{ name: "terminal", title: repo, args: \{ repo \} \}\)/);
  const terminal = read(root, "extensions/terminal/main.ts");
  assert.match(terminal, /import \{ pewt, args, PewtError \} from "pewter"/);
  assert.match(terminal, /await args/);
});

test("the agent tab is the ACP client, and the repos rows know how to open it", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The claim NARRATIVE.md's "Agents" chapter makes: the tab, not the host,
  // speaks the protocol. If the agent screen reached for anything beyond the
  // ordinary API plus its own JSON-RPC, the claim would be decoration.
  const agent = read(root, "extensions/agent/main.ts");
  assert.match(agent, /pewt\.agent\(/);
  assert.match(agent, /session\/request_permission/);
  assert.match(agent, /session\/prompt/);
  // The handshake names the cwd the started agent reported — the one path
  // that crosses to the page, because ACP's session/new requires it.
  assert.match(agent, /info\.cwd/);
  // The same argument arrangement the shell verb uses (#198): the row sends
  // `{repo}`, the agent screen reads it and skips its picker.
  assert.match(read(root, "extensions/repos/main.ts"), /pewt\.tabs\.add\(\{ name: "agent", title: repo, args: \{ repo \} \}\)/);
  assert.match(agent, /await args/);
});

test("the stylesheet import compiles under the checker the scaffold declares", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The terminal imports xterm's stylesheet; esbuild bundles it and tsc has
  // no idea what a .css import means. The ambient declaration is what keeps
  // `pewt check` exit 0 on a fresh pewter, and it lives under extensions/
  // because that is all the tsconfig includes.
  assert.match(read(root, "extensions/terminal/main.ts"), /import "@xterm\/xterm\/css\/xterm\.css"/);
  assert.match(read(root, "extensions/env.d.ts"), /declare module "\*\.css"/);
  assert.deepEqual(JSON.parse(read(root, "tsconfig.json")).include, ["extensions"]);
});

test("everything sorts by what deletes it", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
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
  scaffold({ root });
  assert.deepEqual(JSON.parse(read(root, "tsconfig.json")).include, ["extensions"]);
});

test("a folder with things in it is a merge, not a start", () => {
  const root = into();
  fs.writeFileSync(path.join(root, "notes.md"), "mine");
  assert.throws(() => scaffold({ root }), (e: unknown) => e instanceof NotEmpty);
});

test("a folder that does not exist yet is fine", () => {
  const root = path.join(into(), "deep", "nested", "pewter");
  assert.deepEqual(scaffold({ root }).includes("package.json"), true);
});
