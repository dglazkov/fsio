#!/usr/bin/env node
// Placeholder for `tsc --noEmit` until the TypeScript conversion (#2):
// syntax-checks every .js/.mjs in the given directory (non-recursive — all
// packages are flat). Keeps the wireit check graph real in the meantime.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const files = readdirSync(dir).filter((f) => /\.(js|mjs)$/.test(f));
let failed = false;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "pipe" });
  } catch (e) {
    failed = true;
    console.error(`syntax error in ${f}:\n${e.stderr}`);
  }
}
if (failed) process.exit(1);
console.log(`syntax OK: ${files.length} files in ${path.basename(dir)}`);
