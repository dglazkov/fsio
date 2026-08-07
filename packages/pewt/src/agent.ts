// `agent` — an ACP adapter your pewter depends on, talking over the folder.
//
// Harvested from `acp-demo/src/acp-kind.ts`. What rides where, repeated here
// because the whole risk of two nested JSON-RPC layers is getting it wrong:
//
//   RPC frames  → fsio control plane. `spawn`, `ping`, `close`, and the
//                 `agent/*` methods below. These are *about* the session.
//   DATA frames → ACP payload, one complete message per frame (framing.ts).
//                 The host never interprets it beyond "is this one JSON
//                 object", and never routes an ACP method itself.
//
// Pewter ships no agent and is not an ACP client. Whoever holds the other end
// is: a tab, or — through `pewt agent` — whatever program is on the other side
// of the pipe. That is why `session/request_permission` and `fs/*` are not
// mentioned anywhere in this file. They are requests *from* the agent, and the
// party that answers them is the one with the human and the folder handle.
//
// A kind rather than @fsio/host's `shell`: an adapter is a stdio child, which
// is exactly what a registered kind is for, so the spec is `{repo, agent}` and
// the host resolves it — the `run` shape rather than the `shell` one.
//
// Caveat carried from D13: kinds have no backpressure hook yet (#10). Token
// streams are fine (F12: 2.6–3.7 MB/s downlink); a kind is not the place to
// pipe a file dump.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { ADAPTERS, findAdapter, installLine, resolve, type Adapter } from "./agents.js";
import { classify, isJsonRpc, LineSplitter, toAgentLine } from "./framing.js";
import type { Pewter } from "./pewter.js";

/** Pipes, never a pty (#18): a pty echoes input and rewrites newlines, and
 *  newline-delimited JSON survives neither. */
type AgentProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** How many stderr lines to keep for `agent/diagnostics`. An agent's stderr
 *  is where "I could not authenticate" arrives, and it is not ACP, so it
 *  cannot ride DATA. A client that cannot see it is a client debugging a
 *  silent process.
 *
 *  **And it is unreachable after the agent dies**, which is when it matters
 *  most: `ctx.exit()` drops the kind, so `agent/diagnostics` answers -32601
 *  from the moment there is anything worth asking about. That is
 *  [#98](https://github.com/dglazkov/fsio/issues/98) — a known D13 API gap
 *  with three candidate remedies and none chosen, closed as not planned.
 *  `acp-demo` pins the same edge in a test rather than working around it.
 *
 *  So this file does not work around it either, and does the one thing that
 *  needs no API decision: **every stderr line is also logged**, which puts it
 *  on the terminal running `pewt serve` as it happens. A live client can still
 *  ask; a post-mortem one reads the host's terminal. If #98 is ever settled,
 *  the log line is the thing to reconsider. */
const STDERR_KEEP = 200;
const STDERR_LINE_MAX = 2000;
/** SIGTERM → this long → SIGKILL, on session close. */
const KILL_GRACE_MS = 2000;

/** What the page or the terminal asked for. */
export interface AgentSpec {
  /** an adapter name from the roster, or absent for whichever is installed. */
  agent?: string | undefined;
  /** a directory under `repos/`, or absent for the pewter itself. */
  repo?: string | undefined;
}

/** An agent request resolved against the disk: what the question needs and
 *  what the spawn needs, worked out once. */
export interface AgentPlan {
  adapter: Adapter;
  /** absolute path to the binary npm linked. Never leaves the host. */
  bin: string;
  /** the version in this pewter, or null when its package is unreadable. */
  version: string | null;
  /** true when `asks` was measured against a different version. */
  unmeasured: boolean;
  /** the project this would run on, or absent for the pewter itself. Kept
   *  beside the resolved directory because a standing grant names the project
   *  a human recognizes, not a path (grants.ts). */
  repo?: string | undefined;
  cwd: string;
  /** `cwd`, relative to the pewter — what a human recognizes. */
  where: string;
  /** how the request reads in one line: `agent pi-acp --repo fsio`. */
  label: string;
}

/** The agent cannot start, and this is the sentence saying why. */
export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "AgentError";
  }
}

const isSegment = (name: string): boolean => name !== "" && !name.startsWith(".") && !/[\\/]/.test(name);

/** Resolve a spec against the disk, or refuse it. Nothing is spawned here:
 *  the host asks its question between this and the spawn. */
export function planAgent(p: Pewter, spec: AgentSpec): AgentPlan {
  let cwd = p.root;
  const repo = spec.repo;
  if (repo !== undefined) {
    if (typeof repo !== "string" || !isSegment(repo)) {
      throw new AgentError("bad_repo", `${JSON.stringify(String(repo))} is not a project name`, "a project is a directory under repos/ — `pewt repos` lists them");
    }
    cwd = path.join(p.repos, repo);
    if (!fs.existsSync(cwd)) {
      throw new AgentError("no_repo", `no project named ${repo} in this pewter`, "`pewt repos` lists them");
    }
  }

  // Named, or whichever this pewter has. Naming none is the common case for a
  // tab — a page cannot know what is installed — and it stays safe either
  // way, because the choice is made from the roster and the wire never
  // contributes a path.
  const asked = spec.agent;
  let adapter: Adapter | null;
  if (asked === undefined) {
    adapter = ADAPTERS.find((a) => resolve(p, a) !== null) ?? null;
    if (!adapter) {
      throw new AgentError(
        "no_agent",
        "this pewter has no ACP adapter installed",
        `an adapter is an ordinary dependency — ${ADAPTERS.map((a) => installLine(a)).join(", or ")}`
      );
    }
  } else {
    adapter = findAdapter(asked);
    if (!adapter) {
      throw new AgentError("unknown_agent", `no adapter named ${JSON.stringify(String(asked))}`, `this build knows: ${ADAPTERS.map((a) => a.name).join(", ")} — \`pewt agents\` lists them`);
    }
  }

  const found = resolve(p, adapter);
  if (!found) {
    throw new AgentError(
      "not_installed",
      `${adapter.name} is not installed in this pewter`,
      `${installLine(adapter)} — it is pinned in your lockfile and comes back with \`git clone && npm i\``
    );
  }

  return {
    adapter,
    bin: found.bin,
    version: found.version,
    unmeasured: found.version !== adapter.measured,
    ...(repo !== undefined ? { repo } : {}),
    cwd,
    where: where(p, cwd),
    label: `agent ${adapter.name}${repo ? ` --repo ${repo}` : ""}`,
  };
}

function where(p: Pewter, dir: string): string {
  const rel = path.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}

/** The spec a session carries, read back out. Returns null when this is not
 *  an agent spec — the spawn policy sees every kind. */
export function asAgentSpec(spec: Readonly<Record<string, unknown>>): AgentSpec {
  const agent = spec["agent"];
  const repo = spec["repo"];
  return {
    ...(typeof agent === "string" ? { agent } : {}),
    ...(typeof repo === "string" ? { repo } : {}),
  };
}

/** The measured environment floor (`packages/confine/MEASUREMENTS.md`): eight
 *  variables ran an agent CLI identically to 48-variable inheritance. */
const ENV_FLOOR = ["PATH", "HOME", "TERM", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR"] as const;

/** The agent's environment, synthesized rather than inherited.
 *
 *  `run` and `shell` hand over `process.env`, and that is right for them: a
 *  human asked for that environment and is sitting at it. Nobody is sitting
 *  at an agent, it talks to the network by design, and full inheritance was
 *  measured to carry the whole environment including `SSH_AUTH_SOCK`
 *  (`packages/confine/MEASUREMENTS.md`).
 *
 *  This is not confinement — nothing Pewter starts is confined
 *  (https://github.com/dglazkov/fsio/issues/170). It is the difference between
 *  a wall and not handing over a key.
 *
 *  `pewt` goes on the PATH for the reason NARRATIVE.md gives: the agent reads
 *  `AGENTS.md` and works through `pewt` exactly as you would, which it can
 *  only do if `pewt` is there to run. */
export function agentEnv(p: Pewter, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_FLOOR) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  env["HOME"] ??= os.homedir();
  // An agent is not sitting at a terminal; anything it renders for one is
  // noise on a pipe, and CRLF on a pipe is how NDJSON gets mangled.
  env["TERM"] = "dumb";
  const bin = path.join(p.root, "node_modules", ".bin");
  const current = env["PATH"] ?? "";
  env["PATH"] = current.includes(bin) ? current : `${bin}${path.delimiter}${current}`;
  return env;
}

interface Counters {
  /** ACP messages delivered to the client (one DATA frame each). */
  messagesOut: number;
  /** messages accepted from the client and written to stdin. */
  messagesIn: number;
  /** stdout lines that were not a JSON object — diverted, never delivered. */
  junkLines: number;
  /** delivered messages missing `"jsonrpc":"2.0"` (advisory count). */
  nonRpc: number;
  /** DATA frames from the client the framing contract refused. */
  refusedIn: number;
  /** over-long stdout lines dropped (framing.ts MAX_LINE_BYTES). */
  overflows: number;
}

/** The `agent` session kind. One session, one adapter, one conversation. */
export function agentKind(p: Pewter, log: HostLogger): KindHandler {
  return (ctx: KindContext): KindSession => {
    // Planned twice — once for the question, once here. The second is the one
    // that matters: between the question and the spawn, `npm rm` had time to
    // run. A failed spawn carries a message and nothing else (the host
    // answers 1002 with text), so the hint travels inside the sentence.
    let plan: AgentPlan;
    try {
      plan = planAgent(p, asAgentSpec(ctx.spec));
    } catch (e) {
      throw e instanceof AgentError && e.hint ? new AgentError(e.code, `${e.message} — ${e.hint}`) : e;
    }

    const child = spawn(plan.bin, [], { cwd: plan.cwd, env: agentEnv(p), stdio: ["pipe", "pipe", "pipe"] }) as AgentProcess;

    const counters: Counters = { messagesOut: 0, messagesIn: 0, junkLines: 0, nonRpc: 0, refusedIn: 0, overflows: 0 };
    const stderr: string[] = [];
    const keep = (line: string): void => {
      const kept = line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}…` : line;
      stderr.push(kept);
      if (stderr.length > STDERR_KEEP) stderr.splice(0, stderr.length - STDERR_KEEP);
      // Also on the host's terminal, as it arrives. This is the half of
      // https://github.com/dglazkov/fsio/issues/98 that needs no API decision:
      // a dead agent's last words are legible somewhere even though the
      // method that carries them is gone by the time anybody can ask.
      log.warn(`${plan.adapter.name}: ${kept}`);
    };

    // ---- downlink: agent stdout → one DATA frame per ACP message
    const splitter = new LineSplitter({
      line: (text) => {
        const c = classify(text);
        if (!c.ok) {
          // Junk on stdout is expected in the wild — version notices, npm
          // chatter — and must never reach a client's parser.
          counters.junkLines++;
          keep(`[stdout, not a message: ${c.reason}] ${text.slice(0, 300)}`);
          return;
        }
        if (!isJsonRpc(text)) counters.nonRpc++;
        counters.messagesOut++;
        ctx.write(text);
      },
      overflow: (bytes) => {
        counters.overflows++;
        keep(`[dropped an over-long stdout line: ${bytes} bytes]`);
      },
    });
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));

    // ---- stderr: never delivered as payload (it is not ACP), always kept
    let errBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errBuf += chunk.toString("utf8");
      const lines = errBuf.split("\n");
      errBuf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) keep(l);
    });

    let exited = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (exited) return;
      exited = true;
      if (errBuf.trim()) keep(errBuf.trim());
      log.info(`${plan.label} → exit ${code ?? "?"}${signal ? ` (${signal})` : ""} · ${counters.messagesOut} out, ${counters.messagesIn} in`);
      ctx.exit(code ?? (signal ? 128 : null));
    };
    // "close" rather than "exit": stdio is drained first, so a message the
    // agent wrote just before dying still becomes a frame.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      keep(`[spawn error] ${e.message}`);
      finish(127, null);
    });
    child.stdin.on("error", (e: Error) => keep(`[stdin] ${e.message}`));

    log.info(`${plan.label} → ${plan.adapter.bin}${plan.version ? ` ${plan.version}` : ""} in ${plan.where}/ (pid ${child.pid ?? "?"})`);

    return {
      // What a client needs to render a header without asking again. No path:
      // where npm put the binary is not something a tab needs to use it.
      result: {
        agent: plan.adapter.name,
        title: plan.adapter.title,
        protocol: "acp",
        version: plan.version,
        asks: plan.adapter.asks,
        unmeasured: plan.unmeasured,
        where: plan.where,
        // The cwd, absolute — ACP's `session/new` requires one, and whoever
        // holds the other end is the ACP client, so it has to have it. The
        // same deliberate exception `acp-demo`'s `acp/info` makes to "names,
        // never paths": the path is a label for the folder the page was
        // already granted, not a disclosure of anything beyond it.
        cwd: plan.cwd,
        // The host stamps `pid` with its own (D13: kinds run in-process), so
        // the child's needs its own name.
        agentPid: child.pid ?? null,
      },

      // ---- uplink: one DATA frame → one line on the agent's stdin
      onData: (bytes) => {
        const r = toAgentLine(bytes);
        if (!r.ok) {
          counters.refusedIn++;
          keep(`[refused an uplink frame: ${r.reason}]`);
          return;
        }
        counters.messagesIn++;
        if (!child.stdin.destroyed) child.stdin.write(r.line);
      },

      methods: {
        /** Everything that did not fit the payload channel. A stalled agent
         *  is diagnosable by whoever is driving it rather than only from the
         *  terminal the host happens to be running in. */
        "agent/diagnostics": () => ({ ...counters, pendingBytes: splitter.pending, exited, stderr: [...stderr] }),
      },

      onClose: () => {
        if (exited) return;
        child.kill("SIGTERM");
        const t = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        t.unref();
      },
    };
  };
}
