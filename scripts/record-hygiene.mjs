#!/usr/bin/env node
// Record hygiene — a DIAGNOSIS, not a fixer.
//
// Measures how well the repository holds the layering in PROCESS.md: demos
// are the fast layer and carry no numbered entries, libraries are extractions,
// the protocol is slow, findings are the slowest and are protocol-only, and
// the workbench and labs are instruments. When those layers blur, an agent
// asked to work an issue starts reconciling constraints where only some are
// real — and that failure is silent. It costs sessions, not builds.
//
// This script reports and nothing else. It proposes no fixes and changes no
// files: the right move for each category depends on what the record looks
// like when you run it, and whoever runs it next will have better ideas than
// whoever wrote it. Read the counts, pick a category, fix a slice, run again.
// The numbers going down is the progress bar.
//
// If you are tempted to make this script fix something: don't. Make it *see*
// something new instead. A checker that edits is a checker nobody trusts to
// tell them the truth. It also does not judge — every check below counts
// something, and none of them decide what a thing means.
//
//   node scripts/record-hygiene.mjs            report (always exits 0)
//   node scripts/record-hygiene.mjs --verbose  every site, not just samples
//   node scripts/record-hygiene.mjs --strict   exit 1 if any category is open
//   node scripts/record-hygiene.mjs --json     machine-readable
//
// Not wired into `npm test` on purpose. A gate would force this clean in one
// sitting; the layering is a thing to chip at.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = new Set(process.argv.slice(2));
const VERBOSE = argv.has("--verbose");
const JSON_OUT = argv.has("--json");
const STRICT = argv.has("--strict");

// ------------------------------------------------------------------- layers

const DEMOS = ["packages/terminal-demo", "packages/acp-demo"];
const INSTRUMENTS = ["packages/workbench", "packages/bench", "scripts/"];
const PROTOCOL_CODE = ["packages/common", "packages/client", "packages/host", "packages/fsiod"];
const SPEC = ["spec/PROTOCOL.md", "spec/DECISIONS.md", "spec/FINDINGS.md", "spec/PRINCIPLES.md"];

/** Namespaces that must resolve to a heading in a file (PROCESS.md rule 3). */
const NAMESPACES = {
  F: { file: "spec/FINDINGS.md", heading: /^#{2,4}\s+(F\d+)\s+—\s+(.*)$/ },
  D: { file: "spec/DECISIONS.md", heading: /^#{2,4}\s+(D\d+)\s+—\s+(.*)$/ },
  P: { file: "spec/PRINCIPLES.md", heading: /^#{2,4}\s+(P\d+)\s+—\s+(.*)$/ },
  R: { file: "spec/REQUIREMENTS.md", heading: /^#{2,4}\s+(R\d+)\s+—\s+(.*)$/ },
};

const DEMO_NAME = /packages\/(acp-demo|terminal-demo)/g;

// ---------------------------------------------------------------- file input

const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !/(^|\/)(node_modules|dist)\//.test(f))
  .filter((f) => !/package-lock\.json$|\.(svg|png|jpg|ico|lock)$/.test(f));

const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const exists = (f) => fs.existsSync(path.join(repo, f));
const CITABLE = tracked.filter((f) => /\.(md|ts|mjs|js|json|html|sh|yaml|yml)$/.test(f));
const under = (f, prefixes) => prefixes.some((p) => f.startsWith(p));

// ------------------------------------------------------------- parse entries

/** symbol → {symbol, title, file, line, body} */
const entries = new Map();
const missingFiles = [];

for (const [ns, { file, heading }] of Object.entries(NAMESPACES)) {
  if (!exists(file)) {
    missingFiles.push({ ns, file });
    continue;
  }
  const lines = read(file).split("\n");
  let cur = null;
  const close = (end) => {
    if (cur) {
      cur.body = lines.slice(cur.line, end).join("\n");
      entries.set(cur.symbol, cur);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(heading);
    if (!m) continue;
    close(i);
    cur = { symbol: m[1], title: m[2], file, line: i + 1, body: "" };
  }
  close(lines.length);
}

// ---------------------------------------------------------------- citations

const CITE = /(?<![A-Za-z0-9_#])([FDPR])(\d{1,3})(?![A-Za-z0-9_])/g;
const citations = [];
for (const f of CITABLE) {
  const lines = read(f).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(CITE)) {
      citations.push({ symbol: m[1] + m[2], ns: m[1], file: f, line: i + 1 });
    }
  }
}

const sample = (a, n = 4) => (VERBOSE ? a : a.slice(0, n));
const more = (a, n = 4) => (VERBOSE || a.length <= n ? "" : `    … ${a.length - n} more`);

// ------------------------------------------------------------------- checks

const report = [];
const add = (id, rule, title, why, items, fmt) =>
  report.push({ id, rule, title, why, count: items.length, items, fmt });

// Rule 1 — nothing in spec/ names a demo package.
{
  const items = [];
  for (const f of SPEC.filter(exists)) {
    const lines = read(f).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hits = [...new Set([...lines[i].matchAll(DEMO_NAME)].map((m) => m[0]))];
      if (hits.length) items.push({ file: f, line: i + 1, hits });
    }
  }
  add(
    "spec-names-demo",
    "1",
    "spec/ names a demo package",
    "A normative rule that points at one implementation to explain itself is describing that implementation, not a contract. This is the whole boundary.",
    items,
    (i) => `  ${i.file}:${i.line}  ${i.hits.join(", ")}`
  );
}

// Rule 2 — demos carry no numbered entries of their own. Checked from the
// other side: an entry whose body is mostly about one demo.
{
  const items = [];
  for (const e of entries.values()) {
    const hits = [...new Set([...e.body.matchAll(DEMO_NAME)].map((m) => m[0]))];
    if (hits.length) items.push({ entry: e, hits, n: [...e.body.matchAll(DEMO_NAME)].length });
  }
  add(
    "entry-about-demo",
    "2",
    "Numbered entries written about a demo",
    "A demo's choice does not become a decision by being written in DECISIONS.md. Some of these are legitimate worked examples — read each and decide which.",
    items,
    (i) =>
      `  ${i.entry.symbol.padEnd(5)} ${String(i.n).padStart(2)}× ${i.hits.join(", ")}  ${i.entry.file}:${i.entry.line}`
  );
}

// Rule 2a — demos do not run labs: a finding measuring our own fast layer.
{
  const items = entries
    .values()
    .toArray()
    .filter((e) => e.symbol[0] === "F" && DEMO_NAME.test(e.body) && (DEMO_NAME.lastIndex = 0) === 0);
  add(
    "finding-measures-demo",
    "2a",
    "Findings that measure a demo",
    "A finding is ground the protocol stands on. Measuring the page we shipped is a test or a paragraph, not the slowest layer.",
    items,
    (e) => `  ${e.symbol.padEnd(5)} ${e.file}:${e.line}  ${e.title.slice(0, 62)}`
  );
}

// Rule 3 — if code or spec cites it, it lives in a file.
{
  const bySymbol = new Map();
  for (const c of citations) {
    if (entries.has(c.symbol)) continue;
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol).push(c);
  }
  const items = [...bySymbol.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([symbol, where]) => ({ symbol, sites: where.length, where }));
  add(
    "dangling",
    "3",
    "Citations that resolve to nothing",
    "A number outside an issue is a promise that a file explains it. Either give it a home or take the citation out — a reader cannot tell a real constraint from a remembered one.",
    items,
    (i) =>
      `  ${i.symbol.padEnd(5)} ${String(i.sites).padStart(3)} site(s)\n` +
      sample(i.where).map((w) => `    ${w.file}:${w.line}`).join("\n") +
      (more(i.where) ? "\n" + more(i.where) : "")
  );
}

// Rule 6 — a library is an extraction. Two demos with a same-named module is
// the duplication that already designed one.
{
  const byName = new Map();
  for (const f of tracked.filter((f) => under(f, DEMOS) && /\/src\/[^/]+\.ts$/.test(f))) {
    const base = path.basename(f);
    if (base.startsWith("test-")) continue;
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(f);
  }
  const items = [...byName.entries()]
    .filter(([, fs_]) => fs_.length > 1)
    .map(([base, files]) => ({
      base,
      files,
      lines: files.reduce((n, f) => n + read(f).split("\n").length, 0),
    }))
    .sort((a, b) => b.lines - a.lines);
  add(
    "extractable",
    "6",
    "The same module written in both demos",
    "Duplication across the fast layer is how a library gets designed. Not every row is worth extracting — but a row nobody extracts is a row that grows a record instead.",
    items,
    (i) => `  ${i.base.padEnd(14)} ${String(i.lines).padStart(4)} lines  ${i.files.join("  ")}`
  );
}

// Protocol code leaning on a demo's number. The concrete form of the leak.
{
  const demoEntries = new Set(
    entries
      .values()
      .toArray()
      .filter((e) => {
        DEMO_NAME.lastIndex = 0;
        return DEMO_NAME.test(e.body);
      })
      .map((e) => e.symbol)
  );
  const items = citations.filter(
    (c) => demoEntries.has(c.symbol) && (under(c.file, PROTOCOL_CODE) || c.file === "spec/PROTOCOL.md")
  );
  add(
    "protocol-cites-demo",
    "1",
    "Protocol code citing a demo-flavored entry",
    "The protocol layer has absorbed something from the fast layer. Sharper than the file-level check above, because these are load-bearing.",
    items,
    (i) => `  ${i.file}:${i.line}  cites ${i.symbol}`
  );
}

// Meta — doc files the anchor checker does not read.
{
  const src = exists("scripts/check-anchors.mjs") ? read("scripts/check-anchors.mjs") : "";
  const docs = tracked.filter((f) => f.endsWith(".md") && (f.startsWith("spec/") || !f.includes("/")));
  const items = docs.filter((f) => !src.includes(`"${f}"`)).map((f) => ({ file: f }));
  add(
    "unchecked-docs",
    "—",
    "Doc files check-anchors.mjs does not read",
    "Their internal links can break without failing CI.",
    items,
    (i) => `  ${i.file}`
  );
}

// -------------------------------------------------------------------- census

const census = {
  entries: Object.fromEntries(
    Object.keys(NAMESPACES).map((ns) => [
      ns,
      entries
        .values()
        .toArray()
        .filter((e) => e.symbol[0] === ns).length,
    ])
  ),
  citationsByLayer: {},
};
for (const c of citations) {
  const layer = under(c.file, DEMOS)
    ? "demos"
    : under(c.file, INSTRUMENTS)
      ? "instruments"
      : under(c.file, PROTOCOL_CODE)
        ? "protocol code"
        : c.file.startsWith("spec/")
          ? "spec"
          : "other";
  census.citationsByLayer[layer] = (census.citationsByLayer[layer] ?? 0) + 1;
}

// -------------------------------------------------------------------- output

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        census,
        missingFiles,
        checks: report.map(({ id, rule, title, count, items }) => ({ id, rule, title, count, items })),
      },
      null,
      2
    )
  );
} else {
  const open = report.filter((r) => r.count > 0);
  const total = entries.size;
  console.log(`\nrecord hygiene — ${total} entries, ${citations.length} citations`);
  console.log(`layering per PROCESS.md; this reports, it does not judge\n`);

  console.log("entries    " + Object.entries(census.entries).map(([k, v]) => `${k} ${v}`).join("  ·  "));
  console.log(
    "citations  " +
      Object.entries(census.citationsByLayer)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join("  ·  ")
  );
  console.log();

  for (const { ns, file } of missingFiles) {
    console.log(`note  ${file} does not exist — ${ns}-numbers cited anywhere will show as dangling\n`);
  }

  for (const r of report) {
    console.log(r.count === 0 ? `  ok  [${r.rule}] ${r.title}` : `${String(r.count).padStart(4)}  [${r.rule}] ${r.title}`);
    if (r.count === 0) continue;
    console.log(`      ${r.why}`);
    for (const item of sample(r.items)) console.log(r.fmt(item));
    if (more(r.items)) console.log(more(r.items));
    console.log();
  }

  if (!open.length) console.log("\nnothing open.\n");
  else
    console.log(
      `\n${open.length} of ${report.length} categories open: ` +
        open.map((r) => `${r.id}(${r.count})`).join(" ") +
        `\n\nPick one, fix a slice, run again. --verbose for every site.\n`
    );
}

process.exit(STRICT && report.some((r) => r.count > 0) ? 1 : 0);
