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
import { AGENTS, roster, type AgentEntry } from "./agents.js";

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
      { name: "present", title: "installed", install: "npm i -g present", installed: true, asks: true },
      { name: "absent", title: "a test agent", install: "npm i -g absent", installed: false, asks: false },
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
    assert.ok(a.install.length > 0, `${a.name} must carry an install line for the page to print`);
  }
  assert.equal(AGENTS.find((a) => a.name === "pi-acp")?.asks, false, "#100 measured 0 permission requests from pi-acp");
  assert.equal(AGENTS.find((a) => a.name === "claude-agent-acp")?.asks, true, "F30 measured the card it sends");
});
