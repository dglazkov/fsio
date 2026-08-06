#!/usr/bin/env node
// `npm create pewt@latest <dir>` — make a pewter.
//
//     npm create pewt@latest ~/Documents/code/work-pewter
//     cd ~/Documents/code/work-pewter
//     npm start
//
// Put it anywhere. Nothing depends on where a pewter lives or what it is
// called, and you can have as many as you want.
//
// Three things happen here and each is one you could do by hand: write the
// files, make it a git repository, install its dependencies. The last one is
// what makes `pewt` exist at all — it is installed in the pewter, never
// globally, so `npm start` finds it in `node_modules/.bin` and a machine
// without a pewter has no `pewt` on it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NotEmpty, scaffold, type Source } from "./scaffold.js";

const USAGE = `usage: create-pewt <dir> [--no-install] [--no-git] [--link <path>]

  <dir>          where the pewter goes. Created if missing; must be empty.
  --no-install   write the files and stop, without running npm install
  --no-git       do not make it a git repository
  --link <path>  depend on an fsio checkout instead of the published
                 artifacts, for working on fsio itself`;

const argv = process.argv.slice(2);
let dir: string | null = null;
let install = true;
let git = true;
// The default is the artifact branches, which is what makes a scaffolded
// pewter a real one: it restores with `git clone && npm i` on a machine that
// has never heard of this repository. `--link` opts into a checkout instead,
// and is only interesting to somebody changing fsio.
let source: Source = { kind: "git" };

const fail = (msg: string): never => {
  console.error(`create-pewt: ${msg}\n\n${USAGE}`);
  process.exit(2);
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--no-install") install = false;
  else if (a === "--no-git") git = false;
  else if (a === "--link") source = { kind: "checkout", path: path.resolve(argv[++i] ?? fail("--link needs a path")) };
  else if (a.startsWith("--link=")) source = { kind: "checkout", path: path.resolve(a.slice("--link=".length)) };
  else if (a.startsWith("-")) fail(`unknown flag ${a}`);
  else if (dir) fail("one directory, please");
  else dir = a;
}
if (!dir) fail("which directory should the pewter go in?");

const root = path.resolve(dir!);
if (source.kind === "checkout" && !fs.existsSync(path.join(source.path, "packages/pewt"))) {
  fail(`--link ${source.path} does not look like an fsio checkout (no packages/pewt in it)`);
}

let written: string[];
try {
  written = scaffold({ root, source });
} catch (e) {
  if (e instanceof NotEmpty) {
    fail(`${e.dir} already has things in it. A pewter starts empty, so this would be a merge rather than a start.`);
  }
  throw e;
}

console.log(`\npewter · ${root}\n`);
for (const file of written) console.log(`  ${file}`);
console.log("  repos/");

if (git) {
  // A pewter is a git repository. Failing to make one is not fatal — the
  // folder works either way — so this reports and carries on.
  const r = spawnSync("git", ["init", "--quiet"], { cwd: root, stdio: "inherit" });
  console.log(r.status === 0 ? "\n  git initialized — nothing committed yet" : "\n  git init failed; the pewter is fine without it");
}

if (install) {
  // Just `npm install`, on a `package.json` that declares what it needs.
  // This used to make symlinks by hand, because neither package had
  // published; the symlinks were undeclared, npm pruned them on the next
  // install of anything, and the pewter broke silently (#181). Nothing here
  // is special any more, which is the point.
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\ncreate-pewt: npm install failed in ${root}.`);
    console.error("The files are written and they are correct — run `npm install` there yourself when you know why.");
    process.exit(1);
  }
}

console.log(`
Next:

  cd ${root}
  ${install ? "npm start" : "npm install && npm start"}

That runs \`pewt serve\`, which opens the page and waits. The last step is
yours: pick this folder in the browser and allow it. Picking and allowing are
gestures only Chrome can offer, and they are what stops the page from
reaching anything you did not choose.
`);
