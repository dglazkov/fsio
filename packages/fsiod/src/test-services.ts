// The daemon's service directory (D24/D25): what a page can learn about a
// hub before it has any grant, and what it must not.
//
// The rules under test are all privacy rules with a discovery job attached.
// `services.json` is one file for every co-tenant (D20), so it carries the
// names the user marked advertisable — not paths, not the entries kept out
// of it, not the size of the registry. And it must track `fsio share`
// without a restart, the same "it bites at the next judgment" discipline
// D23 requires of revocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServicesDoc } from "@fsio/common";
import { startDaemon, type Daemon } from "./daemon.js";
import { Registry } from "./registry.js";

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fsiod-svc-"));
  const state = path.join(tmp, "state");
  const hub = path.join(tmp, "hub");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(hub, { recursive: true });
  return {
    tmp,
    state,
    hub,
    dir(name: string) {
      const d = path.join(tmp, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    /** the document as it lands in the hub — bytes, not the daemon's view. */
    doc(): ServicesDoc {
      return JSON.parse(fs.readFileSync(path.join(hub, ".fsio", "services.json"), "utf8")) as ServicesDoc;
    },
    raw: () => fs.readFileSync(path.join(hub, ".fsio", "services.json"), "utf8"),
    beat: () => JSON.parse(fs.readFileSync(path.join(hub, ".fsio", "host.json"), "utf8")) as { servicesRev: number },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

const daemonOpts = (f: ReturnType<typeof fixture>) => ({
  hub: f.hub,
  stateDir: f.state,
  allowTempHub: true,
  watch: false,
  hotPollMs: 0,
  servicesPollMs: 20,
});

const withDaemon = async (f: ReturnType<typeof fixture>, fn: (d: Daemon) => Promise<void>): Promise<void> => {
  const d = await startDaemon(daemonOpts(f));
  try {
    await fn(d);
  } finally {
    await d.stop();
  }
};

const waitFor = async (fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> => {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the daemon publishes a service directory and the heartbeat points at it (D24)", async () => {
  const f = fixture();
  try {
    await withDaemon(f, async () => {
      const doc = f.doc();
      assert.equal(doc.protocol, 0, "the hub chapter is additive (D25)");
      assert.ok(doc.rev >= 1);
      assert.equal(f.beat().servicesRev, doc.rev, "the doorbell names the revision on disk");
      assert.ok(doc.capabilities.includes("workspaces"), "a daemon resolves names, and says so");
      assert.deepEqual(doc.workspaces, [], "no shares yet: an empty roster, not a missing field");
    });
  } finally {
    f.cleanup();
  }
});

test("advertisable names appear; unadvertised ones and every path do not (D22/D24)", async () => {
  const f = fixture();
  try {
    const registry = new Registry(f.state);
    const open = f.dir("open-project");
    const secret = f.dir("secret-project");
    registry.add({ dir: open, name: "open", label: "Open Project" }, f.hub);
    registry.add({ dir: secret, name: "secret", advertise: false }, f.hub);

    await withDaemon(f, async () => {
      const raw = f.raw();
      assert.deepEqual(f.doc().workspaces, [{ name: "open", label: "Open Project" }]);
      assert.ok(!raw.includes("secret"), "a name kept out of the directory must not leak to any tenant");
      assert.ok(!raw.includes(open), "paths never reach the hub folder (D20/D22)");
      assert.ok(!raw.includes(secret), "…including the unadvertised one's");
      assert.ok(!raw.includes(os.homedir()), "…and nothing that discloses the user's home");
    });
  } finally {
    f.cleanup();
  }
});

test("`fsio share` reaches the directory without a daemon restart (D24)", async () => {
  const f = fixture();
  try {
    await withDaemon(f, async () => {
      const rev0 = f.doc().rev;
      // A separate process edits daemon-private state; the daemon notices.
      new Registry(f.state).add({ dir: f.dir("late"), name: "late" }, f.hub);
      await waitFor(() => (f.doc().workspaces ?? []).some((w) => w.name === "late"), "the shared name to be advertised");
      const doc = f.doc();
      assert.ok(doc.rev > rev0, "a content change moves the revision");
      await waitFor(() => f.beat().servicesRev === doc.rev, "the doorbell to catch up");

      // …and unshare removes it, on the same path.
      new Registry(f.state).remove("late");
      await waitFor(() => (f.doc().workspaces ?? []).length === 0, "the name to stop being advertised");
      assert.ok(f.doc().rev > doc.rev);
    });
  } finally {
    f.cleanup();
  }
});

test("a quiet daemon does not rewrite the document (D24)", async () => {
  // The reason it is a separate file from the 2 s heartbeat: the registry
  // poll runs 50×/s here and must cost nothing when nothing changed.
  const f = fixture();
  try {
    await withDaemon(f, async () => {
      const file = path.join(f.hub, ".fsio", "services.json");
      const mtime = fs.statSync(file).mtimeMs;
      const rev = f.doc().rev;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(fs.statSync(file).mtimeMs, mtime, "republishing identical content must not touch the file");
      assert.equal(f.doc().rev, rev);
    });
  } finally {
    f.cleanup();
  }
});

test("the directory tells the truth about grants: shell needs one (D23 rule 1)", async () => {
  const f = fixture();
  try {
    await withDaemon(f, async () => {
      const kinds = f.doc().kinds;
      assert.deepEqual(kinds.find((k) => k.name === "shell"), { name: "shell", needsGrant: true });
      assert.deepEqual(kinds.find((k) => k.name === "echo"), { name: "echo" }, "the transport diagnostic is served ungranted");
    });

    // …and it says the opposite under the `--allow-shell` stand-in, because
    // that daemon really does serve shells without a grant. A document that
    // advertised a consent requirement the daemon does not enforce would
    // send pages to a flow that is not there.
    const d = await startDaemon({ ...daemonOpts(f), allowShell: true });
    try {
      assert.deepEqual(f.doc().kinds.find((k) => k.name === "shell"), { name: "shell" });
    } finally {
      await d.stop();
    }
  } finally {
    f.cleanup();
  }
});

test("a restart adopts the revision rather than rewinding it (D24)", async () => {
  // Clients cache by revision. A daemon restart is invisible to a page
  // holding the folder, so a rev that went 7 → 1 would strand it on a stale
  // copy until something else changed.
  const f = fixture();
  try {
    new Registry(f.state).add({ dir: f.dir("one"), name: "one" }, f.hub);
    let rev = 0;
    await withDaemon(f, async () => {
      rev = f.doc().rev;
    });
    await withDaemon(f, async () => {
      assert.equal(f.doc().rev, rev, "identical content across a restart is not a new revision");
      assert.equal(f.beat().servicesRev, rev, "and the fresh heartbeat still points at it");
    });
    new Registry(f.state).add({ dir: f.dir("two"), name: "two" }, f.hub);
    await withDaemon(f, async () => {
      assert.equal(f.doc().rev, rev + 1, "a change while the daemon was down moves it exactly once");
    });
  } finally {
    f.cleanup();
  }
});
