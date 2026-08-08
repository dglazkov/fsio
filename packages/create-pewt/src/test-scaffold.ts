// What a new pewter is, checked against what the host expects to find.
//
// The scaffolder and `@fsio/pewt` have to agree about the folder or a fresh
// pewter opens to an error: the `pewter` field the host walks up looking
// for, the extension layout the bundler compiles, and the four things
// .gitignore sorts by what deletes them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
test("pewt, pewter and pewter-ui are declared, which is what stops npm pruning them", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  const pkg = JSON.parse(read(root, "package.json"));
  assert.equal(pkg.dependencies.pewt, "github:dglazkov/fsio#pewt");
  assert.equal(pkg.dependencies.pewter, "github:dglazkov/fsio#pewter");
  assert.equal(pkg.dependencies["pewter-ui"], "github:dglazkov/fsio#pewter-ui");
});

test("--link spells them as relative file: paths, with no home directory in them", () => {
  const root = path.join(into(), "p");
  scaffold({ root, source: { kind: "checkout", path: repo } });
  const pkg = JSON.parse(read(root, "package.json"));
  for (const name of ["pewt", "pewter", "pewter-ui"]) {
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
    assert.deepEqual(Object.keys(dependencies("/p", source)).sort(), ["pewt", "pewter", "pewter-ui"]);
  }
});

test("the extensions are the templates, byte for byte", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The whole arrangement: extensions are real files in this repository,
  // and a pewter gets copies, not renderings. Nothing escaped, nothing
  // interpolated — so what CI typechecks under templates/ is exactly what
  // `pewt check` compiles in the pewter.
  const templates = path.resolve(import.meta.dirname, "../templates");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(templates, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else files.push(`${dir}/${entry.name}`);
    }
  };
  walk("extensions");
  assert.ok(files.length >= 10, `templates hold the extensions (${files.length} files)`);
  for (const rel of files) {
    assert.equal(read(root, rel), fs.readFileSync(path.join(templates, rel), "utf8"), `${rel} is a verbatim copy`);
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
  assert.match(main, /import \{ explain, pewt, type Project \} from "pewter"/);
  assert.match(main, /pewt\.repos\.list\(\)/);
});

test("the shared look is pewter-ui, and every screen imports it", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The extraction (#164's rule-6 shape): three screens had written the same
  // palette and blocks, so the shared half moved to a package — declared
  // like the emulator, imported like a stylesheet, swappable like both.
  for (const ext of ["repos", "terminal", "agent"]) {
    assert.match(read(root, `extensions/${ext}/main.ts`), /import "pewter-ui\/style\.css"/, `${ext} imports the shared look`);
  }
  // Two shapes of screen, both on the same kit. `repos` and `terminal` are
  // lit templates over signals, drawn by the kit's `screen()`; `agent` still
  // holds its transcript by hand and drives the same elements through their
  // methods. Importing anything from the package registers the elements, so
  // both shapes get the tags — and it is HTMLElementTagNameMap that makes
  // them typed, which is the discovery rail `pewt check` and an editor read.
  for (const ext of ["repos", "terminal"]) {
    assert.match(read(root, `extensions/${ext}/main.ts`), /import \{ screen \} from "pewter-ui"/, `${ext} draws with the kit's screen`);
    assert.match(read(root, `extensions/${ext}/main.ts`), /from "@lit-labs\/signals"/, `${ext} holds its state in signals`);
    assert.match(read(root, `extensions/${ext}/main.ts`), /from "lit"/, `${ext} describes itself as a template`);
  }
  const terminal = read(root, "extensions/terminal/main.ts");
  assert.match(terminal, /<pewter-status/, "the terminal's status line is the kit's");
  assert.match(terminal, /<pewter-menu \.choices=/, "the terminal's picker is the kit's menu");
  // The agent, unconverted: the same two elements, driven the imperative way.
  const agent = read(root, "extensions/agent/main.ts");
  assert.match(agent, /import "pewter-ui";/, "agent registers the elements");
  assert.match(agent, /document\.querySelector\("pewter-menu"\)/, "agent queries the menu by tag");
  assert.match(read(root, "extensions/agent/index.html"), /<pewter-status hidden><\/pewter-status>/);
  assert.match(read(root, "extensions/agent/index.html"), /<pewter-menu><\/pewter-menu>/);
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
  // One call for both verbs, each row naming which extension it opens. The
  // title falls back for the pewter itself, which has no repo name.
  assert.match(repos, /pewt\.tabs\.add\(\{ name, title: repo \?\? "this pewter", args: \{ repo \} \}\)/);
  assert.match(repos, /openTab\("terminal", repo\.name\)/);
  const terminal = read(root, "extensions/terminal/main.ts");
  assert.match(terminal, /import \{ pewt, args, explain \} from "pewter"/);
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
  assert.match(read(root, "extensions/repos/main.ts"), /openTab\("agent", repo\.name\)/);
  assert.match(agent, /await args/);
});

test("an agent can be started in the pewter itself, not only in a project", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // `extensions/` is at the pewter root, so an agent asked to write a screen
  // has to start above the repos rather than inside one. The header's verb is
  // the only way to say that from the page: closing the agent tab and opening
  // it bare reaches the same place, but nothing on a page opens an extension
  // (#187), so without this the pewter-wide agent needs a terminal.
  const repos = read(root, "extensions/repos/main.ts");
  assert.match(repos, /openTab\("agent", null\)/);
  // Both ends of that argument, the way the shell verb's is pinned above: the
  // header sends `{repo: null}` and the agent screen has to mean the pewter
  // by it rather than fall through to its picker. `null` is a value `repo`
  // carries, so `"repo" in` is what tells it from an argument that is absent.
  const agent = read(root, "extensions/agent/main.ts");
  assert.match(agent, /"repo" in openedWith/);
  assert.match(agent, /typeof where === "string" \|\| where === null/);
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
  // somewhere public. Anchored: an earlier bare `repos/` matched a directory
  // of that name at any depth and swallowed `extensions/repos/`, and the
  // assertion here was written in the same shape, so it pinned the bug
  // instead of catching it. The real check is the git one below.
  assert.match(ignored, /^\/repos\/$/m);
  // Regenerated: the channel and this pewter's own state.
  assert.match(ignored, /^\/\.fsio\/$/m);
  assert.match(ignored, /^\/\.pewter\/$/m);
  // Committed: the pewter itself. Absent from the ignore file on purpose.
  for (const kept of ["AGENTS.md", "package.json", "tsconfig.json", "extensions/"]) {
    assert.doesNotMatch(ignored, new RegExp(`^${kept.replace(".", "\\.")}$`, "m"));
  }
  assert.ok(fs.statSync(path.join(root, "repos")).isDirectory(), "repos/ exists on disk though it is never in history");
});

test("a clone brings the screens back — git agrees, not just the ignore file", () => {
  const root = path.join(into(), "p");
  scaffold({ root });
  // The one assertion that would have caught the anchoring bug. A `.gitignore`
  // is a set of patterns with real semantics, and reading it as strings is how
  // `extensions/repos/` — the first screen a pewter shows — spent a day being
  // silently uncommittable while NARRATIVE.md promised a clone restores it.
  // So ask git, which is the only thing that actually decides.
  if (spawnSync("git", ["init", "--quiet"], { cwd: root }).status !== 0) return; // no git here; nothing to prove
  const ignores = (rel: string): boolean => spawnSync("git", ["check-ignore", "-q", rel], { cwd: root }).status === 0;
  for (const kept of ["extensions/repos/main.ts", "extensions/agent/main.ts", "extensions/terminal/main.ts", "AGENTS.md", "package.json", "tsconfig.json"]) {
    assert.ok(!ignores(kept), `${kept} must be committable — a clone that does not restore it is not the pewter`);
  }
  // And the other direction still holds: your work, the channel and the
  // remembered answers stay out of history.
  for (const dropped of ["repos/anything", ".fsio/x", ".pewter/grants.json", "node_modules/x"]) {
    assert.ok(ignores(dropped), `${dropped} must stay out of history`);
  }
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
