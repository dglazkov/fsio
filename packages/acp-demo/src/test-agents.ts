// The agent roster (#102): what the helper tells the page this machine has.
//
// Two properties are worth a test rather than a reading. First, discovery
// is *enumeration of the allow-list*, not a search — the boundary that
// keeps a chooser from becoming a remote-controlled exec surface (#6, P3).
// Second, the roster rides `services.json`, which one file serves to every
// granted origin (D24), so it must carry names and prose and **no paths**.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, installLine, resolve, roster, type AgentEntry } from "./agents.js";

const entry = (over: Partial<AgentEntry> & { name: string; bin: string }): AgentEntry => ({
  args: [],
  title: "a test agent",
  install: "npm i -g nothing",
  asks: false,
  state: { mode: "place", env: "TEST_STATE", why: "the fixture keeps no state" },
  ...over,
});

test("the roster reports presence per entry, and reports it as a fact about PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-roster-"));
  try {
    const there = path.join(dir, "here-agent");
    fs.writeFileSync(there, "#!/bin/sh\n", { mode: 0o755 });

    const lines = roster([
      entry({ name: "present", bin: there, title: "installed", install: "npm i -g present", asks: true }),
      entry({ name: "absent", bin: path.join(dir, "nope"), install: "npm i -g absent" }),
    ]);

    assert.deepEqual(lines, [
      { name: "present", title: "installed", install: "npm i -g present", installed: true, asks: true, via: "PATH" },
      { name: "absent", title: "a test agent", install: "npm i -g absent", installed: false, asks: false, via: null },
    ]);

    // A missing agent stays *listed*. It is the whole reason the helper no
    // longer exits on an empty roster: the page cannot offer an install
    // command for an entry it was never told about.
    assert.equal(lines.length, 2, "an agent that is not installed is still an offer");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory on PATH is not an agent, and neither is a non-executable file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-roster-"));
  try {
    fs.mkdirSync(path.join(dir, "dir-agent"));
    fs.writeFileSync(path.join(dir, "plain-agent"), "not executable\n", { mode: 0o644 });
    const lines = roster([entry({ name: "d", bin: path.join(dir, "dir-agent") }), entry({ name: "p", bin: path.join(dir, "plain-agent") })]);
    assert.deepEqual(lines.map((l) => l.installed), [false, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the published roster carries no paths (D24: one file serves every granted origin)", () => {
  // The shipped allow-list, not a fixture: this is the object that actually
  // reaches the wire, and `bin` — the one field that resolves to a path —
  // must not be in it.
  const lines = roster(AGENTS);
  const wire = JSON.stringify(lines);
  assert.ok(lines.length > 0, "the demo ships a non-empty allow-list");
  for (const a of AGENTS) {
    const resolved = lines.find((l) => l.name === a.name)!;
    assert.ok(resolved, `${a.name} should appear in the roster`);
    assert.ok(!Object.hasOwn(resolved as object, "bin"), "the resolved binary is not the page's business");
  }
  assert.ok(!wire.includes(os.homedir()), "no $HOME-derived path may ride the service directory");
  assert.ok(!/"[^"]*\/[^"]*\/[^"]*"/.test(wire.replace(/"install":"[^"]*"/g, "")), `no path-shaped value outside install lines: ${wire}`);
});

test("every shipped entry declares whether it asks — the field the chooser turns on", () => {
  // Measured, not assumed (F30, #100). A missing declaration would render as
  // "edits with its own hands" in the page, which is a claim about consent
  // and must never be a default someone forgot to set.
  for (const a of AGENTS) {
    assert.equal(typeof a.asks, "boolean", `${a.name} must declare asks`);
    assert.ok(installLine(a).length > 0, `${a.name} must carry an install line for the page to print`);
  }
  assert.equal(AGENTS.find((a) => a.name === "pi-acp")?.asks, false, "#100 measured 0 permission requests from pi-acp");
  assert.equal(AGENTS.find((a) => a.name === "claude-agent-acp")?.asks, true, "F30 measured the card it sends");
});

test("what the helper would install and what it tells you to type are the same software (#124)", () => {
  // The two paths must not drift. An unpinned printed line beside a pinned
  // automatic install is a machine that behaves differently depending on
  // which one you took, and the profile in this file is measured against one
  // specific version (F30) — so "latest" is the wrong answer on both paths.
  //
  // The rule this cannot check, and which was got wrong once already: the
  // pinned version must be **the one that was measured**, not the newest.
  // Both entries were first pinned to whatever `npm view` reported that day
  // (0.64.2 and 0.0.33) while F30 and MEASUREMENTS.md had measured 0.64.0
  // and 0.0.32 — which is "install whatever is current" wearing a pin's
  // clothing, and defeats the entire point. Bumping a version here means
  // re-measuring first; nothing mechanical will stop you.
  for (const a of AGENTS) {
    assert.ok(a.pkg, `${a.name} must carry npm coordinates`);
    assert.match(a.pkg!.version, /^\d+\.\d+\.\d+$/, `${a.name} must pin an exact version, never a range`);
    assert.equal(installLine(a), `npm i -g ${a.pkg!.name}@${a.pkg!.version}`);
  }
});

test("exactly one entry is the one offered to a machine with none (#124)", () => {
  const offered = AGENTS.filter((a) => a.recommended);
  assert.equal(offered.length, 1, "an empty-roster prompt asks one question, so it names one agent");
  assert.equal(offered[0]!.asks, true, "the offer is the agent whose consent card is what this demo is for (#100, F30)");
});

test("PATH beats ~/.fsio/agents, and the roster says which copy won (#124)", () => {
  // Two copies can coexist: someone with a global install who also answered
  // `y` here. Running the one nobody expected is a debugging trap that looks
  // like a version bug, so the precedence is fixed and it is reported.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-precedence-"));
  const oldPath = process.env["PATH"];
  const oldHome = process.env["HOME"];
  try {
    const home = path.join(dir, "home");
    const onPath = path.join(dir, "bin");
    fs.mkdirSync(onPath, { recursive: true });
    const managed = path.join(home, ".fsio", "agents", "two-copies", "node_modules", ".bin");
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(managed, "two-copies"), "#!/bin/sh\n", { mode: 0o755 });

    const e = entry({ name: "two-copies", bin: "two-copies" });
    // HOME is what `agentsHome()` reads, and it is read at call time so the
    // test can move it. Only the fsio copy exists yet.
    process.env["HOME"] = home;
    process.env["PATH"] = onPath;
    assert.deepEqual(resolve(e), { bin: path.join(managed, "two-copies"), via: "fsio" });

    // Now a global install appears. It is the later, deliberate act — usually
    // made precisely to get a different version — so it wins.
    fs.writeFileSync(path.join(onPath, "two-copies"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(resolve(e), { bin: path.join(onPath, "two-copies"), via: "PATH" });
    assert.equal(roster([e])[0]!.via, "PATH", "the page is told which copy it is driving");
  } finally {
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
