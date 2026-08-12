#!/usr/bin/env node
// Link checker for the doc set (AGENTS.md convention: bare #N doesn't
// autolink; heading-slug anchors break silently on rename). Runs as part of
// `npm test` (root wireit graph) so a broken link is a CI failure, not a
// reviewer's eyeball catch.
//
// Two checks, against two different ways a link rots:
//
//   anchors   every ](file.md#anchor) and ](#anchor) is matched against
//             GitHub-style slugs of the target's headings.
//   repo URLs every https://github.com/dglazkov/fsio/{blob,tree}/main/<path>
//             is matched against the working tree. Package READMEs ship to
//             artifact branches (#224), where a relative ../../spec/… link
//             resolves to nothing, so they link home by absolute URL instead —
//             and an absolute URL is exactly the kind that keeps looking fine
//             after the file behind it moves.
//
// The package READMEs are in scope for both. They were unchecked until #224,
// which is also when they acquired links worth checking.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exists = (p) => fs.existsSync(path.join(repo, p));

const packageReadmes = fs
  .readdirSync(path.join(repo, "packages"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `packages/${e.name}/README.md`);

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
  ...packageReadmes,
].filter(exists);

// GitHub's slugger: lowercase, strip punctuation, spaces → hyphens.
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");

// Keyed by repo-relative path, not by basename: nine packages now carry a
// README.md, and a basename key would merge all of their headings into one set
// that accepts every anchor and catches nothing.
const anchors = new Map();
for (const f of FILES) {
  const text = fs.readFileSync(path.join(repo, f), "utf8");
  anchors.set(f, new Set([...text.matchAll(/^#+\s+(.*)$/gm)].map((m) => slug(m[1]))));
}

let bad = 0;
const fail = (msg) => {
  console.error(`BROKEN: ${msg}`);
  bad++;
};

for (const f of FILES) {
  const text = fs.readFileSync(path.join(repo, f), "utf8");
  const dir = path.dirname(f);

  for (const m of text.matchAll(/\]\((?:([A-Za-z0-9._/-]+\.md))?#([A-Za-z0-9\-_]+)\)/g)) {
    // Resolve relative to the linking file, so ../../spec/DECISIONS.md from a
    // package README lands on the same key the spec was registered under.
    const target = m[1] ? path.normalize(path.join(dir, m[1])) : f;
    const set = anchors.get(target);
    if (set && !set.has(m[2])) fail(`${f} → ${m[1] ?? ""}#${m[2]}`);
  }

  for (const m of text.matchAll(/https:\/\/github\.com\/dglazkov\/fsio\/(?:blob|tree)\/main\/([A-Za-z0-9._/-]+)/g)) {
    if (!exists(m[1])) fail(`${f} → ${m[0]} (no such path in the working tree)`);
  }
}

if (bad) {
  console.error(`${bad} broken link(s)`);
  process.exit(1);
}
console.log(`links ok (${FILES.length} files)`);
