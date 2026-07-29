#!/usr/bin/env node
// One-line CI status with correct semantics, for agent watch loops.
//
//   node scripts/ci-status.mjs <pr-number>   status of a PR's checks
//   node scripts/ci-status.mjs main          status of the latest run on main
//
// Prints exactly one line: "pass …", "fail …", or "pending …".
// Exit codes: 0 pass · 1 fail · 2 pending.
//
// Why this exists: `gh run watch` and sleep-polling loops are
// permission-blocked in some agent environments, and hand-rolled
// `gh pr checks` parsing has two traps this file encodes once — the
// "skipping" bucket is neither pass nor fail (a jq `all(.bucket ==
// "pass")` never fires), and the tab-separated text output's second
// column is the job name, not the status. Watch loops become:
//   until node scripts/ci-status.mjs 51; do sleep 30; done   # inside Monitor

import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
  console.error("usage: ci-status.mjs <pr-number|main>");
  process.exit(2);
}

const gh = (...args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));

let verdict, detail;
try {
  if (target === "main") {
    const runs = gh("run", "list", "--branch", "main", "--limit", "1", "--json", "status,conclusion,displayTitle");
    const r = runs[0];
    if (!r) throw new Error("no runs on main");
    if (r.status !== "completed") [verdict, detail] = ["pending", `${r.status}: ${r.displayTitle}`];
    else [verdict, detail] = [r.conclusion === "success" ? "pass" : "fail", `${r.conclusion}: ${r.displayTitle}`];
  } else {
    const checks = gh("pr", "checks", target, "--json", "name,bucket");
    const by = (b) => checks.filter((c) => c.bucket === b);
    if (checks.length === 0) [verdict, detail] = ["pending", "no checks reported yet"];
    else if (by("fail").length) [verdict, detail] = ["fail", by("fail").map((c) => c.name).join(", ")];
    else if (by("pending").length) [verdict, detail] = ["pending", `${by("pending").length} running`];
    else if (by("pass").length) [verdict, detail] = ["pass", `${by("pass").length} pass, ${by("skipping").length} skipped`];
    else [verdict, detail] = ["pending", "only skipped checks so far"];
  }
} catch (e) {
  // gh pr checks exits non-zero while checks are pending — but --json
  // still emits on stdout; a real failure lands here.
  console.log(`pending (gh error: ${e.message?.split("\n")[0]})`);
  process.exit(2);
}
console.log(`${verdict} ${detail}`);
process.exit(verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2);
