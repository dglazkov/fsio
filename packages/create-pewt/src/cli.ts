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
import { link as linkPackages, NotEmpty, scaffold } from "./scaffold.js";

const USAGE = `usage: create-pewt <dir> [--no-install] [--no-git] [--link <path>]

  <dir>          where the pewter goes. Created if missing; must be empty.
  --no-install   write the files and stop, without linking pewt and pewter
  --no-git       do not make it a git repository
  --link <path>  the fsio checkout to link from (default: this one)`;

const argv = process.argv.slice(2);
let dir: string | null = null;
let install = true;
let git = true;
// Until `pewt` and `pewter` publish, a new pewter depends on a checkout of
// this repository. Two levels up from dist/ is the package; four is the repo.
let link = path.resolve(import.meta.dirname, "../../..");

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
  else if (a === "--link") link = path.resolve(argv[++i] ?? fail("--link needs a path"));
  else if (a.startsWith("--link=")) link = path.resolve(a.slice("--link=".length));
  else if (a.startsWith("-")) fail(`unknown flag ${a}`);
  else if (dir) fail("one directory, please");
  else dir = a;
}
if (!dir) fail("which directory should the pewter go in?");

const root = path.resolve(dir!);
if (!fs.existsSync(path.join(link, "packages/pewt"))) {
  fail(`--link ${link} does not look like an fsio checkout (no packages/pewt in it)`);
}

let written: string[];
try {
  written = scaffold({ root, link });
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
  try {
    for (const at of linkPackages(root, link)) console.log(`  ${at}`);
    console.log(`\n  pewt and pewter are linked from ${link}, not installed from a registry —
  neither has published yet. This pewter therefore needs that checkout as
  well as itself, which is the one way it differs from the documentation.`);
  } catch (e) {
    console.error(`\ncreate-pewt: ${e instanceof Error ? e.message : String(e)}`);
    console.error("The files are written; link them yourself and then `npm start`.");
    process.exit(1);
  }
}

console.log(`
Next:

  cd ${root}
  ${install ? "npm start" : "# link pewt and pewter, then: npm start"}

That runs \`pewt serve\`, which opens the page and waits. The last step is
yours: pick this folder in the browser and allow it. Picking and allowing are
gestures only Chrome can offer, and they are what stops the page from
reaching anything you did not choose.
`);
