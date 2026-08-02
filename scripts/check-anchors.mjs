#!/usr/bin/env node
// Heading-anchor link checker for the doc set (AGENTS.md convention:
// bare #N doesn't autolink; heading-slug anchors break silently on
// rename). Checks every ](file.md#anchor) and ](#anchor) in the listed
// files against GitHub-style slugs of the target's headings. Runs as
// part of `npm test` (root wireit graph) so a broken anchor is a CI
// failure, not a reviewer's eyeball catch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = [
  "spec/PROTOCOL.md",
  "spec/FINDINGS.md",
  "spec/DECISIONS.md",
  "spec/PRINCIPLES.md",
  "TESTING.md",
  "README.md",
  "AGENTS.md",
  "PROCESS.md",
  "NARRATIVE.md",
].filter((f) => fs.existsSync(path.join(repo, f)));

// GitHub's slugger: lowercase, strip punctuation, spaces → hyphens.
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");

const anchors = new Map();
for (const f of FILES) {
  const text = fs.readFileSync(path.join(repo, f), "utf8");
  anchors.set(path.basename(f), new Set([...text.matchAll(/^#+\s+(.*)$/gm)].map((m) => slug(m[1]))));
}

let bad = 0;
for (const f of FILES) {
  const text = fs.readFileSync(path.join(repo, f), "utf8");
  for (const m of text.matchAll(/\]\((?:([A-Za-z0-9._-]+\.md))?#([A-Za-z0-9\-_]+)\)/g)) {
    const target = m[1] ?? path.basename(f);
    const set = anchors.get(target);
    if (set && !set.has(m[2])) {
      console.error(`BROKEN: ${f} → ${target}#${m[2]}`);
      bad++;
    }
  }
}
if (bad) {
  console.error(`${bad} broken anchor(s)`);
  process.exit(1);
}
console.log(`anchors ok (${FILES.length} files)`);
