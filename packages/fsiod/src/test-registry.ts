// Workspace-registry conformance (D22) + daemon-private state (D20).
// Every scenario gets its own state dir, hub, and workspaces (TESTING.md:
// hermetic or it doesn't merge).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry, defaultName, isValidName } from "./registry.js";
import { assertOutsideHub, hubKey, stateDirPath, STATE_ENV } from "./state.js";

interface Fixture {
  state: string;
  hub: string;
  dir(name: string): string;
  registry(): Registry;
  cleanup(): void;
}

function fixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fsiod-reg-"));
  const state = path.join(tmp, "state");
  const hub = path.join(tmp, "hub");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(hub, { recursive: true });
  return {
    state,
    hub,
    dir(name: string) {
      const d = path.join(tmp, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    registry: () => new Registry(state),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

const withFixture = async (fn: (f: Fixture) => void | Promise<void>): Promise<void> => {
  const f = fixture();
  try {
    await fn(f);
  } finally {
    f.cleanup();
  }
};

// ------------------------------------------------------------ names (D22)

test("names are bounded, lowercase, and path-shaped things are not names", () => {
  for (const ok of ["repo", "my-app", "a", "fsio.spec", "x_1", "a".repeat(64)]) {
    assert.ok(isValidName(ok), `${ok} should be valid`);
  }
  for (const bad of ["", "Repo", "../etc", "a/b", "a b", ".hidden", "-lead", "trail-", "a".repeat(65), "é"]) {
    assert.ok(!isValidName(bad), `${bad} should be rejected`);
  }
});

test("a default name is derived from the folder; an explicit one is never mangled", async () => {
  await withFixture((f) => {
    assert.equal(defaultName("/Users/x/Code/My App"), "my-app");
    assert.equal(defaultName("/"), "workspace");
    const r = f.registry();
    // Explicit and invalid must fail loudly rather than be sanitized: a
    // silently renamed workspace is a name the page will ask for and miss.
    assert.throws(() => r.add({ dir: f.dir("proj"), name: "Not Valid" }, f.hub), /invalid workspace name/);
  });
});

// ------------------------------------------------- state privacy (D20)

test("the registry lives outside the hub, mode 0600, in a 0700 state dir", async () => {
  await withFixture((f) => {
    const r = f.registry();
    r.add({ dir: f.dir("proj") }, f.hub);
    assert.ok(!r.file.startsWith(f.hub), "registry must not live inside the granted folder (D20)");
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
    // and nothing about it leaked into the hub
    assert.deepEqual(fs.readdirSync(f.hub), []);
  });
});

test("assertOutsideHub refuses private state inside the granted folder (D20)", async () => {
  await withFixture((f) => {
    assert.throws(() => assertOutsideHub(path.join(f.hub, "state"), f.hub), /inside the hub/);
    assert.throws(() => assertOutsideHub(f.hub, f.hub), /inside the hub/);
    assertOutsideHub(f.state, f.hub); // the real arrangement: no throw
  });
});

test("hubKey is per-directory and survives symlink aliases", async () => {
  await withFixture((f) => {
    const link = path.join(path.dirname(f.hub), "hub-link");
    fs.symlinkSync(f.hub, link);
    assert.equal(hubKey(link), hubKey(f.hub), "one directory, one key — else one hub gets two locks (D21)");
    assert.notEqual(hubKey(f.dir("other")), hubKey(f.hub));
  });
});

test("FSIO_STATE_DIR relocates the state root", () => {
  const before = process.env[STATE_ENV];
  try {
    process.env[STATE_ENV] = "/tmp/fsio-state-probe";
    assert.equal(stateDirPath(), "/tmp/fsio-state-probe");
    delete process.env[STATE_ENV];
    assert.ok(path.isAbsolute(stateDirPath()), "a default must exist on every platform");
  } finally {
    if (before === undefined) delete process.env[STATE_ENV];
    else process.env[STATE_ENV] = before;
  }
});

// --------------------------------------------------- registration (D22)

test("share → list → get round-trips through the file, and a fresh reader sees it", async () => {
  await withFixture((f) => {
    const dir = f.dir("repo");
    const e = f.registry().add({ dir, label: "The Repo" }, f.hub);
    assert.equal(e.name, "repo");
    assert.equal(e.path, fs.realpathSync(dir));
    assert.equal(e.advertise, true);
    assert.equal(e.profile, "default");
    // A second Registry is the daemon: it reads what the CLI wrote.
    const daemon = f.registry();
    assert.equal(daemon.get("repo")!.label, "The Repo");
    assert.equal(daemon.list().length, 1);
  });
});

test("a live registry re-reads on change: share and unshare bite at the next judgment, not the next restart", async () => {
  await withFixture((f) => {
    const daemon = f.registry();
    const resolve = daemon.resolver();
    assert.ok("error" in resolve(undefined, {} as never), "no workspaces yet");

    const cli = f.registry();
    cli.add({ dir: f.dir("repo") }, f.hub);
    const after = resolve("repo", {} as never);
    assert.ok("root" in after && after.root === fs.realpathSync(path.join(path.dirname(f.hub), "repo")));

    // Revocation must take effect at the next judgment (D23's rule for
    // grants; the registry is the same shape of authority).
    cli.remove("repo");
    assert.ok("error" in resolve("repo", {} as never), "unshared names must stop resolving immediately");
  });
});

test("duplicate names refuse rather than silently repoint; --replace is the explicit way", async () => {
  await withFixture((f) => {
    const r = f.registry();
    r.add({ dir: f.dir("a"), name: "w" }, f.hub);
    assert.throws(() => r.add({ dir: f.dir("b"), name: "w" }, f.hub), /already points at/);
    const e = r.add({ dir: f.dir("b"), name: "w", replace: true }, f.hub);
    assert.equal(e.path, fs.realpathSync(f.dir("b")));
    assert.equal(r.list().length, 1);
  });
});

test("refusals: a missing dir, the filesystem root, and any folder containing the hub", async () => {
  await withFixture((f) => {
    const r = f.registry();
    assert.throws(() => r.add({ dir: path.join(f.hub, "nope") }, f.hub), /no such directory/);
    assert.throws(() => r.add({ dir: "/" }, f.hub), /filesystem root/);
    // The hub's parent contains the transport: a child sandboxed to that
    // workspace could rewrite its own session files (D6).
    assert.throws(() => r.add({ dir: path.dirname(f.hub) }, f.hub), /contains the hub/);
  });
});

test("refusing $HOME is a rule, not a warning — a writable dotfile is execution outside the wall, later", async () => {
  await withFixture((f) => {
    const before = process.env["HOME"];
    const fakeHome = f.dir("home");
    try {
      process.env["HOME"] = fakeHome;
      // hub outside the fake home, so this is the $HOME rule firing alone
      assert.throws(() => f.registry().add({ dir: fakeHome }, f.hub), /home directory/);
    } finally {
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });
});

test("unshare reports whether it removed anything", async () => {
  await withFixture((f) => {
    const r = f.registry();
    r.add({ dir: f.dir("repo") }, f.hub);
    assert.equal(r.remove("nope"), false);
    assert.equal(r.remove("repo"), true);
    assert.equal(r.list().length, 0);
  });
});

// -------------------------------------------------------- resolver (D22)

test("resolver: one entry answers an omitted name; two entries refuse it rather than pick", async () => {
  await withFixture((f) => {
    const r = f.registry();
    const resolve = r.resolver();
    r.add({ dir: f.dir("only") }, f.hub);
    const one = resolve(undefined, {} as never);
    assert.ok("root" in one && one.name === "only");

    r.add({ dir: f.dir("second") }, f.hub);
    const two = resolve(undefined, {} as never);
    // The one behavior a subject parameter must never have (D22): the
    // client would be told it ran somewhere it did not.
    assert.ok("error" in two, "omission with several workspaces must be 1006, not workspace zero");
    assert.match(two.error, /name a workspace/);
  });
});

test("resolver refusals name no other workspace and disclose no path", async () => {
  await withFixture((f) => {
    const r = f.registry();
    r.add({ dir: f.dir("secret-project"), name: "secret-project" }, f.hub);
    r.add({ dir: f.dir("other") }, f.hub);
    const miss = r.resolver()("nope", {} as never);
    assert.ok("error" in miss);
    assert.ok(!miss.error.includes("secret-project"), "an error must not enumerate workspaces the client wasn't told about");
    assert.ok(!miss.error.includes("/"), `a refusal must not leak a path: ${miss.error}`);
  });
});

test("a hostile workspace name is bounded and stripped before it echoes back", async () => {
  await withFixture((f) => {
    const nasty = `\u001b[2J\u0007${"x".repeat(500)}`;
    const miss = f.registry().resolver()(nasty, {} as never);
    assert.ok("error" in miss);
    // status.json is read by humans in terminals and by pages; neither
    // should receive escape sequences a client chose.
    assert.ok(!/[\u001b\u0007]/.test(miss.error), "control characters must be stripped");
    assert.ok(miss.error.length < 128, `error must stay bounded, got ${miss.error.length}`);
  });
});

test("a corrupt registry file resolves to nothing, never to a guess", async () => {
  await withFixture((f) => {
    const r = f.registry();
    r.add({ dir: f.dir("repo") }, f.hub);
    fs.writeFileSync(r.file, "{ not json");
    const fresh = f.registry();
    assert.equal(fresh.list().length, 0);
    assert.ok("error" in fresh.resolver()("repo", {} as never));
  });
});
