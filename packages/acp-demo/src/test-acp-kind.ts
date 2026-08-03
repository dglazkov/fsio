// B1-tier tests for the `acp` kind: the REAL @fsio/client over the Node fs
// shim, against a REAL HostServer with the kind registered — the same tier
// D13's registry tests run at, because this is the first real kind and the
// claims worth pinning are transport claims.
//
// What each test pins is cited at the test. The load-bearing one is the
// first: a frame boundary is a message boundary, in both directions, no
// matter how the agent chunks its pipe writes.
//
// The agent here is a fixture (test-fake-agent.ts), never a real one: these
// tests must not need an installed agent, a model key, or a network.
// Nothing here is confined — this demo dropped its sandbox (#145) —
// which is also
// what makes the suite runnable on CI's Linux leg; the profile itself is
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer } from "@fsio/host";
import { FsioClient, RpcError, type FsioSession } from "@fsio/client";
import { RpcErrors } from "@fsio/common";
import { ShimDirectory, type ShimFaults } from "@fsio/bench/dist/fs-shim.js";
import { acpKind } from "./acp-kind.js";
import { ENV_FLOOR } from "./env.js";
import type { AgentEntry } from "./agents.js";

const fixture = path.join(import.meta.dirname, "test-fake-agent.js");

const FAKE: AgentEntry = {
  name: "fake",
  bin: process.execPath,
  args: [fixture],
  title: "fixture agent",
  install: "(built with this repo)",
  asks: false,
  state: { mode: "place", env: "FAKE_STATE", why: "the fixture takes its state dir from the environment" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface Rig {
  client: FsioClient;
  root: string;
  /** every DATA frame, decoded — one entry per frame, on purpose. */
  frames: string[];
  session: FsioSession;
  /** fault injection (#37/#116): armed mid-test to abort the next commits. */
  faults: ShimFaults;
  /** send one ACP message as one DATA frame. */
  send: (msg: unknown) => void;
  /** await the reply carrying this id, parsed. */
  reply: (id: number) => Promise<Record<string, unknown>>;
}

async function withAcp(
  fn: (rig: Rig) => Promise<void>,
  opts: { agents?: AgentEntry[]; env?: NodeJS.ProcessEnv; home?: string; spec?: Record<string, unknown> } = {}
): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsio-acp-")));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsio-acp-tmp-")));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-acp-state-"));
  const server = new HostServer({ root });
  server.registerKind(
    "acp",
    acpKind({
      root,
      fsioDir: path.join(root, ".fsio"),
      tmp: scratch,
      stateRoot,
      agents: opts.agents ?? [FAKE],
      ...(opts.env ? { env: opts.env } : {}),
    })
  );
  await server.start();
  const faults: ShimFaults = {};
  const client = new FsioClient(new ShimDirectory(root, faults));
  const frames: string[] = [];
  let session: FsioSession | null = null;
  try {
    await client.connect();
    const s = client.createSession({ kind: "acp", client: "b1-acp", ...(opts.spec ?? {}) }, { pollMs: 5 });
    session = s;
    s.on("data", (b) => frames.push(new TextDecoder().decode(b)));
    const rig: Rig = {
      client,
      root,
      frames,
      session: s,
      faults,
      send: (msg) => s.sendData(JSON.stringify(msg)),
      reply: async (id) => {
        const hit = await waitFor(() => frames.find((f) => (JSON.parse(f) as { id?: unknown }).id === id), `reply ${id}`);
        return JSON.parse(hit) as Record<string, unknown>;
      },
    };
    await fn(rig);
  } finally {
    try {
      await session?.close();
    } catch {}
    await server.close();
    for (const d of [root, scratch, stateRoot]) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ------------------------------------------------ the framing contract (D13 + framing.ts)

test("one DATA frame carries exactly one ACP message, even when the agent chunks its writes", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    rig.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await rig.reply(1);
    assert.equal((init["result"] as { protocolVersion: number }).protocolVersion, 1);

    // The fixture answers `split` in three pipe writes: reassembly happens
    // host-side, so the page still sees one frame with one whole message.
    const before = rig.frames.length;
    rig.send({ jsonrpc: "2.0", id: 2, method: "split" });
    const split = await rig.reply(2);
    assert.equal((split["result"] as { split: boolean }).split, true);
    assert.equal(rig.frames.length, before + 1, "a split message must not arrive as two frames");
    // Every frame delivered so far parses on its own — the property the
    // browser wrapper is allowed to rely on.
    for (const f of rig.frames) JSON.parse(f);
  });
});

test("junk on the agent's stdout is diverted to diagnostics, never delivered as payload", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    rig.send({ jsonrpc: "2.0", method: "junk" });
    await waitFor(() => rig.frames.some((f) => (JSON.parse(f) as { method?: string }).method === "still/here"), "the message after the junk");
    assert.equal(rig.frames.length, 1, "the version notice and the JSON array must not reach the page");
    const { result } = await rig.session.request<Record<string, unknown>>("acp/diagnostics");
    assert.equal(result["junkLines"], 2);
    assert.ok((result["stderr"] as string[]).some((l) => l.includes("Update available")));
  });
});

test("an over-long line is dropped and the stream resyncs (framing limit, #10's no-backpressure caveat)", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    rig.send({ jsonrpc: "2.0", method: "flood" });
    await waitFor(() => rig.frames.some((f) => (JSON.parse(f) as { method?: string }).method === "after/flood"), "the message after the flood");
    assert.equal(rig.frames.length, 1);
    const { result } = await rig.session.request<Record<string, unknown>>("acp/diagnostics");
    assert.equal(result["overflows"], 1);
  });
});

test("a DATA frame with two messages is refused, and the agent never sees it", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    // Smuggling attempt: one frame, two lines.
    rig.session.sendData('{"jsonrpc":"2.0","id":9,"method":"echo"}\n{"jsonrpc":"2.0","id":10,"method":"echo"}');
    rig.session.sendData("not json at all");
    rig.send({ jsonrpc: "2.0", id: 11, method: "count" });
    const counted = await rig.reply(11);
    // The fixture counts what reached its stdin: only the `count` request.
    assert.equal((counted["result"] as { messages: number }).messages, 1);
    const { result } = await rig.session.request<Record<string, unknown>>("acp/diagnostics");
    assert.equal(result["refusedIn"], 2);
    assert.equal(result["messagesIn"], 1);
  });
});

// ------------------------------------------------ session facts the page reads (D13 result fields)

test("the spawn result states who is running, and claims nothing about confinement", async () => {
  await withAcp(async (rig) => {
    const info = await rig.session.ready;
    assert.equal(info.kind, "acp");
    assert.equal(info["agent"], "fake");
    assert.equal(info["protocol"], "acp");
    assert.equal((info["state"] as { mode: string }).mode, "place");
    // This demo confines nothing (#145). The fields that used to say so are
    // gone rather than reporting `false`, and that is the assertion: a page
    // reading `sandboxed: false` renders "NOT sandboxed", which is a claim
    // about a wall — and there is no wall here to have an opinion about.
    // Absent is the honest shape; a falsy field would be a fresh promise
    // that some future spawn might set it true.
    for (const gone of ["sandboxed", "confinement", "profile"]) {
      assert.ok(!(gone in info), `${gone} must not ride the spawn result any more`);
    }
  });
});

test("acp/info reports the policy path, argv, and the exact env the child got", async () => {
  const env = { ...process.env, SSH_AUTH_SOCK: "/tmp/fsio-test-agent-socket", AWS_SECRET_ACCESS_KEY: "s3cret" };
  await withAcp(
    async (rig) => {
      await rig.session.ready;
      const { result } = await rig.session.request<Record<string, unknown>>("acp/info");
      assert.equal(result["agent"], "fake");
      assert.deepEqual(result["argv"], [process.execPath, fixture]);
      assert.ok((result["pid"] as number) > 0);
      const keys = result["env"] as string[];
      // The measured floor plus the placement variable — and nothing else.
      // The sharp item is the point (full inheritance hands a child the
      // ssh-agent socket): synthesized env is the only
      // lever that can withhold it, and a sandbox is not that lever.
      assert.ok(!keys.includes("SSH_AUTH_SOCK"), `SSH_AUTH_SOCK leaked into the agent's env: ${keys.join(",")}`);
      assert.ok(!keys.includes("AWS_SECRET_ACCESS_KEY"));
      assert.ok(keys.includes("FAKE_STATE"), "the placement variable must be set — placement, not carve-out");
      for (const k of keys) assert.ok(([...ENV_FLOOR] as string[]).includes(k) || k === "FAKE_STATE", `unexpected env var ${k}`);
    },
    { env }
  );
});

test('an "own" posture is handed no placement variable, and says why', async () => {
  // The posture outlived the sandbox that motivated half of it. What it used
  // to decide was which dirs a Seatbelt profile opened; what it decides now
  // is whether the child is told to keep its state somewhere else at all —
  // and for these two agents the answer is no, because placing the state
  // moves the identity with it and logs them out (MEASUREMENTS.md). An agent
  // that quietly received a placement variable would come up as nobody.
  const owner: AgentEntry = { ...FAKE, state: { mode: "own", why: "fixture keeps its credential beside its state" } };
  await withAcp(
    async (rig) => {
      await rig.session.ready;
      const { result } = await rig.session.request<Record<string, unknown>>("acp/info");
      const state = result["state"] as { mode: string; why: string };
      assert.equal(state.mode, "own");
      assert.equal(state.why, "fixture keeps its credential beside its state", "the reason travels to the page, not just the mode");
      assert.ok(!(result["env"] as string[]).includes("FAKE_STATE"), "an owned posture must not be handed a placement variable");
    },
    { agents: [owner] }
  );
});

// ------------------------------------------------ the allow-list (#6) and lifecycle (D13)

test("a page cannot name an agent this helper does not serve", async () => {
  await withAcp(
    async (rig) => {
      await assert.rejects(rig.session.ready, (e: unknown) => {
        assert.ok(e instanceof RpcError);
        assert.equal(e.code, RpcErrors.SPAWN_FAILED);
        assert.match(e.message, /unknown agent "\/usr\/bin\/evil"/);
        assert.match(e.message, /this helper serves: fake/);
        return true;
      });
    },
    { spec: { agent: "/usr/bin/evil" } }
  );
});

test("naming no agent picks an installed one from the allow-list", async () => {
  await withAcp(async (rig) => {
    const info = await rig.session.ready;
    assert.equal(info["agent"], "fake");
  });
});

test("the agent's exit becomes the session's exit, and takes the kind's methods with it (D13 exit())", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    const states: { state: string; exitCode?: number | null }[] = [];
    rig.session.on("status", (st) => states.push(st as { state: string; exitCode?: number | null }));
    rig.send({ jsonrpc: "2.0", method: "noise" }); // something for the tail to hold
    await sleep(50);
    rig.send({ jsonrpc: "2.0", method: "quit", params: { code: 3 } });
    const exited = await waitFor(() => states.find((s) => s.state === "exited"), "the exited status");
    assert.equal(exited.exitCode, 3);

    // The sharp edge, pinned rather than worked around: `exit()` stops
    // delivery to the kind (D13), so `acp/diagnostics` is gone at exactly
    // the moment a page most wants the stderr tail — a crashed agent's
    // "EPERM writing …" is the name-the-real-cause material, and it is
    // unreachable
    // post-mortem. A page must hold its last snapshot; the API gap is
    // filed separately, not papered over here.
    await assert.rejects(rig.session.request("acp/diagnostics", undefined, { timeoutMs: 3000 }), (e: unknown) => {
      assert.equal((e as RpcError).code, -32601);
      return true;
    });
  });
});

// ----------------------------------------------------- sticky sessions (D18, #113)

test("detach leaves the agent running, and a reattach replays what it said as history", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    const pid = (await rig.session.request<Record<string, unknown>>("acp/info")).result["pid"] as number;
    rig.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await rig.reply(1);
    assert.equal(rig.frames.length, 1);

    // The one-word change #113 is built on: the page walks away instead of
    // closing, and the agent it was talking to is still there.
    await rig.session.detach();
    await sleep(200);
    assert.equal(alive(pid), true, "detach must not kill the agent — a session ends when the human ends it");

    // What a returning page does. `replay: true` re-delivers the stream's
    // head, and the bracket is what makes it distinguishable from live
    // traffic: an ACP client that cannot tell the two apart would re-run the
    // agent's file writes against a folder that has moved on.
    const marks: string[] = [];
    const replayed: string[] = [];
    const live: string[] = [];
    let replaying = false;
    const s2 = rig.client.attachSession(rig.session.id, { pollMs: 5, replay: true, client: "b1-acp-again" });
    s2.on("replay", (phase, gen) => {
      marks.push(`${phase}@${gen}`);
      replaying = phase === "start";
    });
    s2.on("data", (b) => (replaying ? replayed : live).push(new TextDecoder().decode(b)));
    await s2.ready;

    assert.deepEqual(marks, ["start@0", "end@0"], "one bracket, and it names the segment it replayed (#57's ceiling)");
    assert.equal(replayed.length, 1, "everything the agent said before the walk-away comes back");
    assert.equal((JSON.parse(replayed[0]!) as { id: number }).id, 1);
    assert.equal(live.length, 0, "and none of it is mistaken for live traffic");

    // Same process, same conversation: the kind survived the client, so its
    // methods still answer and the pid has not moved. This is why a
    // reattached page does not re-handshake (#113) — nothing restarted.
    assert.equal((await s2.request<Record<string, unknown>>("acp/info")).result["pid"], pid);

    s2.sendData(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo" }));
    await waitFor(() => live.find((f) => (JSON.parse(f) as { id?: unknown }).id === 2), "the reply on the reattached uplink");
    assert.equal(replayed.length, 1, "replay is a bracket, not a mode — live frames stay live");

    // The other half of the bargain: closing is still what kills it, and
    // now it is the only thing that does.
    await s2.close();
    await waitFor(() => !alive(pid), "the agent process to die on an explicit close");
  });
});

test("an aborted attach commit retries with a fresh aid instead of losing the session (#116)", async () => {
  await withAcp(async (rig) => {
    await rig.session.ready;
    const pid = (await rig.session.request<Record<string, unknown>>("acp/info")).result["pid"] as number;
    rig.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await rig.reply(1);
    await rig.session.detach();

    // The field failure (#115), reproduced: Chrome aborts the bootstrap
    // commit's close(). One abort used to reject `ready`, and the /acp page
    // read that as "the session is gone" and started a second conversation
    // on top of a live agent.
    rig.faults.closeAborts = 1;
    const notes: string[] = [];
    const s2 = rig.client.attachSession(rig.session.id, { pollMs: 5, replay: true, client: "b1-retry" });
    s2.on("note", (n) => notes.push(n));
    const attached = (await s2.ready) as unknown as { epoch: number };

    assert.equal(rig.faults.closeAborts, 0, "the injected abort must actually have been consumed");
    assert.ok(
      notes.some((n) => n.includes("attach request")),
      `the retry should be observable, got: ${JSON.stringify(notes)}`
    );
    assert.ok((s2.stats.commitRetries ?? 0) >= 1, "the retry is counted (#37's stat, same purpose)");
    // Same agent, one epoch: the retry granted exactly once. A same-aid
    // retry would have granted twice and left this client writing to the
    // older epoch's uplink — fenced by its own second request (D18).
    assert.equal((await s2.request<Record<string, unknown>>("acp/info")).result["pid"], pid);
    assert.equal(attached.epoch, 1, "one grant, not two");

    // And the recovered attach is a working one, not just a resolved promise.
    const live: string[] = [];
    s2.on("data", (b) => live.push(new TextDecoder().decode(b)));
    s2.sendData(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo" }));
    await waitFor(() => live.find((f) => (JSON.parse(f) as { id?: unknown }).id === 2), "a reply after the retried attach");
    await s2.close();
  });
});

test("closing the session kills the agent (D6: cleanup stays host-owned)", async () => {
  let pid = 0;
  await withAcp(async (rig) => {
    await rig.session.ready;
    const { result } = await rig.session.request<Record<string, unknown>>("acp/info");
    pid = result["pid"] as number;
    assert.ok(pid > 0);
    await rig.session.close();
    await waitFor(() => !alive(pid), "the agent process to die");
  });
  assert.equal(alive(pid), false);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
