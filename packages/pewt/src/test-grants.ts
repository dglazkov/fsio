// The grants file, without a host on it.
//
// What is tested here is the memory: what a grant is called, what it covers,
// what happens to a file nobody can read, and that a name in that file is
// compared and never resolved. The other half — that answering `a` at the
// host's terminal writes one and the next question is not asked — spawns a
// process and lives in test-run.ts, test-shell.ts and test-agent.ts, beside
// the questions it is about.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeGrant, grantId } from "pewter";
import { GrantsError, readGrants, recordGrant, revokeGrant, standingGrant, writeGrants } from "./grants.js";
import { pewterAt, type Pewter } from "./pewter.js";

/** An empty pewter, gone at the end of the test. Temp is fine: F9 is Chrome's
 *  file observer, and nothing here opens a browser. */
function pewter(fn: (p: Pewter) => void): void {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-grants-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  try {
    fn(pewterAt(root)!);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a grant is named by what it covers, so the same answer twice is one row", () => {
  assert.equal(grantId({ kind: "run", repo: "fsio" }), "run/fsio");
  assert.equal(grantId({ kind: "run" }), "run/.");
  assert.equal(grantId({ kind: "agent", adapter: "pi-acp", repo: "site" }), "agent/pi-acp/site");
  assert.equal(grantId({ kind: "agent", adapter: "pi-acp" }), "agent/pi-acp/.");

  // "npm install included" since #193: an install question records this
  // grant, so the sentence a human reads must say what it covers.
  assert.equal(describeGrant({ kind: "run", repo: "fsio" }), "any run in fsio, npm install included");
  assert.equal(describeGrant({ kind: "run" }), "any run in the pewter itself, npm install included");
  assert.equal(describeGrant({ kind: "agent", adapter: "pi-acp", repo: "site" }), "pi-acp in site");
});

test("an agent grant names the adapter, so one adapter's yes is not another's", () => {
  // The whole content of an agent's question is the line about whether it
  // asks before it edits. A grant that skipped the adapter would carry that
  // answer over to software nobody read that line about.
  const grants = [{ kind: "agent" as const, adapter: "pi-acp", repo: "fsio", granted: "2026-08-06T00:00:00.000Z" }];
  assert.ok(standingGrant(grants, { kind: "agent", adapter: "pi-acp", repo: "fsio" }));
  assert.equal(standingGrant(grants, { kind: "agent", adapter: "claude-agent-acp", repo: "fsio" }), null);
  assert.equal(standingGrant(grants, { kind: "agent", adapter: "pi-acp", repo: "site" }), null);
  assert.equal(standingGrant(grants, { kind: "agent", adapter: "pi-acp" }), null);
});

test("a run grant covers a project rather than a script, and only that project", () => {
  const grants = [{ kind: "run" as const, repo: "fsio", granted: "2026-08-06T00:00:00.000Z" }];
  // No script anywhere in the key: a script is a line in that project's
  // package.json, and the next one is a line away.
  assert.ok(standingGrant(grants, { kind: "run", repo: "fsio" }));
  assert.equal(standingGrant(grants, { kind: "run", repo: "site" }), null);
  assert.equal(standingGrant(grants, { kind: "run" }), null);
  assert.equal(standingGrant(grants, { kind: "agent", adapter: "pi-acp", repo: "fsio" }), null);
});

test("a pewter nobody has answered `always` in remembers nothing", () => {
  pewter((p) => {
    assert.deepEqual(readGrants(p), []);
    assert.equal(fs.existsSync(p.grants), false, "reading must not create the file");
  });
});

test("an answer is written down, read back, and is one row however often it is given", () => {
  pewter((p) => {
    const first = recordGrant(p, { kind: "run", repo: "fsio" }, "2026-08-06T12:06:02.000Z");
    assert.equal(first.already, false);
    assert.equal(grantId(first.grant), "run/fsio");

    const again = recordGrant(p, { kind: "run", repo: "fsio" }, "2026-08-07T09:00:00.000Z");
    assert.equal(again.already, true);
    // The date is the first answer's, because the row is the first answer's.
    assert.equal(again.grant.granted, "2026-08-06T12:06:02.000Z");
    assert.equal(readGrants(p).length, 1);

    recordGrant(p, { kind: "agent", adapter: "pi-acp" }, "2026-08-06T12:07:00.000Z");
    assert.deepEqual(readGrants(p).map(grantId), ["run/fsio", "agent/pi-acp/."]);
  });
});

test("revoking takes one back by name, and refuses a name that is not there", () => {
  pewter((p) => {
    recordGrant(p, { kind: "run", repo: "fsio" });
    recordGrant(p, { kind: "run", repo: "site" });
    const gone = revokeGrant(p, "run/fsio");
    assert.equal(gone.repo, "fsio");
    assert.deepEqual(readGrants(p).map(grantId), ["run/site"]);
    assert.throws(
      () => revokeGrant(p, "run/fsio"),
      (e: unknown) => e instanceof GrantsError && e.code === "no_grant"
    );
  });
});

test("a grants file nobody can read stops the question rather than reading as empty", () => {
  // Silently forgetting every answer is merely annoying. The same silence in
  // the other direction is a host allowing something nobody remembers
  // allowing, so an unreadable file is a refusal that names itself and says
  // how to get moving again.
  pewter((p) => {
    fs.mkdirSync(p.state, { recursive: true });
    for (const bad of ["not json at all", "{}", '{"grants":{}}', '{"grants":[{"kind":"shell"}]}', '{"grants":[{"kind":"agent","granted":"x"}]}', '{"grants":[{"kind":"run","repo":"fsio"}]}']) {
      fs.writeFileSync(p.grants, bad);
      assert.throws(
        () => readGrants(p),
        (e: unknown) => e instanceof GrantsError && e.code === "unreadable" && /delete .pewter\/grants.json/.test(e.hint ?? ""),
        `expected ${JSON.stringify(bad)} to be refused`
      );
    }
  });
});

test("a name in the file is compared and never resolved", () => {
  // Anything that can write the folder can write this file (spec/PROTOCOL.md,
  // threat model). A repo name that climbs out of repos/ is not refused here
  // and does not have to be: it is only ever compared against a plan the host
  // already resolved off its own disk, so it matches nothing.
  pewter((p) => {
    writeGrants(p, [{ kind: "run", repo: "../../etc", granted: "2026-08-06T00:00:00.000Z" }]);
    const grants = readGrants(p);
    assert.equal(grants.length, 1);
    assert.equal(standingGrant(grants, { kind: "run", repo: "fsio" }), null);
    assert.equal(standingGrant(grants, { kind: "run" }), null);
  });
});
