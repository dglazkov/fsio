// The `acp` session kind (D13): an agent process on one side, a browser ACP
// client on the other, and a folder in between.
//
// What rides where, in one place, because the whole risk of two nested
// JSON-RPC layers is getting this wrong:
//
//   RPC frames  → fsio control plane. `spawn`, `ping`, `close`, and the
//                 `acp/*` methods below. These are *about* the session.
//   DATA frames → ACP payload, one complete message per frame (framing.ts).
//                 The host never interprets it beyond "is this one JSON
//                 object", and never routes an ACP method itself.
//
// The `acp/` prefix is reserved for transport-level questions the page asks
// the *host* (who is the agent? what is confining it? what did it print on
// stderr?). No ACP method is ever answered here — the agent answers those,
// and the page is its client. If a method looks like it could go either
// way, it belongs on DATA.
//
// The browser is the ACP client on purpose: `session/request_permission`
// and `fs/read_text_file` arrive as agent→client *requests*, and the party
// that should answer them is the one with the human and the directory
// handle. That is the demo — the agent's permission prompt becomes page UI
// (R6) instead of a redraw inside a terminal nobody can style, and the
// agent's file reads are served by the page through the grant the human
// already made.
//
// Caveat carried from D13: kinds have no backpressure hook yet (#10). Token
// streams are fine (F12: 2.6-3.7 MB/s downlink); a kind is not the place to
// pipe a file dump.
import fs from "node:fs";
import path from "node:path";
import type { KindContext, KindHandler, KindSession } from "@fsio/host";
import { AGENTS, carveDirs, findAgent, resolveBin, scratchDirs, type AgentEntry } from "./agents.js";
import { synthesizeEnv } from "./env.js";
import { classify, isJsonRpc, LineSplitter, toAgentLine } from "./framing.js";
import { agentProfile, profileSummary } from "./profile.js";
import { spawnAgent, type AgentProcess, type SandboxConfig } from "./sandbox.js";

/** How many stderr lines to keep for `acp/diagnostics`. An agent's stderr
 *  is the only channel that carries "your profile denied me" (R19), so the
 *  page must be able to show it — a demo whose failures are invisible is
 *  the failure mode F26 named. */
const STDERR_KEEP = 200;
const STDERR_LINE_MAX = 2000;
/** SIGTERM → this long → SIGKILL, on session close. */
const KILL_GRACE_MS = 2000;

export interface AcpKindOptions {
  /** realpath of the shared folder: the agent's cwd, and the only place
   *  outside its own state it may write. */
  root: string;
  /** realpath of ROOT/.fsio. */
  fsioDir: string;
  /** realpath of the child's scratch dir (becomes TMPDIR, writable). */
  tmp: string;
  /** where per-agent state goes for a "place" posture. Interim: R17 wants
   *  the host-owned slot `~/.fsio/state/<workspace>/<service>/`, which needs
   *  #71 and a profile carve exactly that wide. */
  stateRoot: string;
  /** confine with sandbox-exec. `false` must be a deliberate caller choice
   *  (non-macOS, tests) and is reported to the page as `sandboxed: false` —
   *  never inferred, never silent (R3). */
  sandbox: boolean;
  /** allow-list override (tests point at a fixture agent). */
  agents?: AgentEntry[];
  /** env floor source (tests supply their own). */
  env?: NodeJS.ProcessEnv;
  /** $HOME a "carve" posture resolves against (tests supply their own so a
   *  test never widens the wall around the real user's dotfiles). */
  home?: string;
}

interface Counters {
  /** ACP messages delivered to the page (one DATA frame each). */
  messagesOut: number;
  /** ACP messages accepted from the page and written to stdin. */
  messagesIn: number;
  /** stdout lines that were not a JSON object — diverted, never delivered. */
  junkLines: number;
  /** delivered messages missing `"jsonrpc":"2.0"` (advisory count). */
  nonRpc: number;
  /** DATA frames from the page the framing contract refused. */
  refusedIn: number;
  /** over-long stdout lines dropped (framing.ts MAX_LINE_BYTES). */
  overflows: number;
  bytesOut: number;
  bytesIn: number;
}

export function acpKind(opts: AcpKindOptions): KindHandler {
  const agents = opts.agents ?? AGENTS;
  return (ctx: KindContext): KindSession => {
    // A page may name an agent, or name none and take what this machine
    // has. Naming none is the common case (the page cannot know what is
    // installed), and it stays safe because the choice is made from the
    // allow-list either way — the wire never contributes a path.
    const asked = ctx.spec["agent"];
    const entry = asked === undefined ? agents.find((a) => resolveBin(a) !== null) ?? null : findAgent(asked, agents);
    if (!entry) {
      // A throw fails the spawn with 1002 (D13) — the page sees a refusal
      // with this text, which is why it names the alternatives.
      throw new Error(
        asked === undefined
          ? `no ACP agent found on this machine's PATH; this helper knows: ${agents.map((a) => `${a.name} (${a.bin})`).join(", ")}`
          : `unknown agent ${JSON.stringify(asked)}; this helper serves: ${agents.map((a) => a.name).join(", ")}`
      );
    }
    const bin = resolveBin(entry);
    if (!bin) throw new Error(`agent ${entry.name} is not on this machine's PATH (looked for "${entry.bin}")`);

    // ---- state: placed or carved, per the agent's declared posture
    const stateDirs = opts.home === undefined ? carveDirs(entry) : carveDirs(entry, opts.home);
    let placedDir: string | undefined;
    if (entry.state.mode === "place") {
      placedDir = path.join(opts.stateRoot, entry.name);
      fs.mkdirSync(placedDir, { recursive: true });
      stateDirs.push(fs.realpathSync(placedDir));
    }

    // ---- the profile: written per session, inside the folder the page can
    // read. The policy confining the agent is inspectable from the same
    // page that is driving it (R1) — `acp/info` returns this path.
    const profileDir = path.join(opts.fsioDir, "profiles");
    const profilePath = path.join(profileDir, `${ctx.sessionId}.sb`);
    const sandbox: SandboxConfig | null = opts.sandbox
      ? { profilePath, root: opts.root, fsio: opts.fsioDir, tmp: opts.tmp }
      : null;
    // Dirs the agent's own tooling hardcodes outside $HOME (F30). Resolved
    // against the shared folder, because the path is per-workspace.
    const scratches = scratchDirs(entry, opts.root);
    if (sandbox) {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        profilePath,
        agentProfile({ stateDirs, agent: entry.name, scratchDirs: scratches, ...(entry.scratchPatterns ? { scratchPatterns: entry.scratchPatterns } : {}) })
      );
    }

    const env = synthesizeEnv(entry, { tmp: opts.tmp, ...(placedDir ? { stateDir: placedDir } : {}), ...(opts.env ? { from: opts.env } : {}) });

    const counters: Counters = { messagesOut: 0, messagesIn: 0, junkLines: 0, nonRpc: 0, refusedIn: 0, overflows: 0, bytesOut: 0, bytesIn: 0 };
    const stderr: string[] = [];
    const keep = (line: string): void => {
      stderr.push(line.length > STDERR_LINE_MAX ? line.slice(0, STDERR_LINE_MAX) + "…" : line);
      if (stderr.length > STDERR_KEEP) stderr.splice(0, stderr.length - STDERR_KEEP);
    };

    let child: AgentProcess;
    try {
      child = spawnAgent({ file: bin, args: entry.args, env, cwd: opts.root, sandbox });
    } catch (e) {
      // Fail-closed: a sandbox that cannot be applied is a spawn that does
      // not happen (R3). 1002, with the reason, in the page.
      throw new Error(`refusing to run ${entry.name} unconfined: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ---- downlink: agent stdout → one DATA frame per ACP message
    const splitter = new LineSplitter({
      line: (text) => {
        const c = classify(text);
        if (!c.ok) {
          counters.junkLines++;
          keep(`[stdout, not a message: ${c.reason}] ${text.slice(0, 300)}`);
          ctx.log.warn(`agent ${entry.name} wrote non-message stdout (${c.reason})`);
          return;
        }
        if (!isJsonRpc(text)) counters.nonRpc++;
        counters.messagesOut++;
        counters.bytesOut += text.length;
        ctx.write(text);
      },
      overflow: (bytes) => {
        counters.overflows++;
        ctx.log.warn(`agent ${entry.name}: dropped a ${bytes}-byte line with no newline (framing limit)`);
        keep(`[dropped an over-long stdout line: ${bytes} bytes]`);
      },
    });
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));

    // ---- stderr: never delivered as payload (it is not ACP), always kept.
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
      ctx.log.info(`agent ${entry.name} exited (code ${code}, signal ${signal ?? "none"})`);
      ctx.exit(code ?? (signal ? 128 : null));
    };
    // "close" rather than "exit": stdio is drained first, so a message the
    // agent wrote just before dying still becomes a frame.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      keep(`[spawn error] ${e.message}`);
      ctx.log.error(`agent ${entry.name}: ${e.message}`);
      finish(127, null);
    });
    child.stdin.on("error", (e: Error) => keep(`[stdin] ${e.message}`));

    const summary = profileSummary(path.basename(opts.root), stateDirs, scratches);
    ctx.log.info(`agent ${entry.name} (pid ${child.pid}) ${sandbox ? "confined" : "UNCONFINED"} — ${summary}`);

    return {
      // Spawn-result extras (D13): everything the page needs to render the
      // session header honestly, without asking a second question.
      result: {
        agent: entry.name,
        title: entry.title,
        protocol: "acp",
        // The host stamps `pid` with its own (D13: kinds run in-process);
        // the agent is a child of it, so its pid needs its own name.
        agentPid: child.pid ?? null,
        sandboxed: !!sandbox,
        confinement: sandbox ? summary : "not confined — this helper is running without a sandbox",
        state: { mode: entry.state.mode, dirs: stateDirs, why: entry.state.why },
      },

      // ---- uplink: one DATA frame → one line on the agent's stdin
      onData: (bytes) => {
        const r = toAgentLine(bytes);
        if (!r.ok) {
          counters.refusedIn++;
          ctx.log.warn(`refused a DATA frame from the page: ${r.reason}`);
          keep(`[refused an uplink frame: ${r.reason}]`);
          return;
        }
        counters.messagesIn++;
        counters.bytesIn += r.line.length;
        if (!child.stdin.destroyed) child.stdin.write(r.line);
      },

      methods: {
        /** Who is running, under what, and where the policy file is — the
         *  page reads that file through the same folder handle (R1). */
        "acp/info": () => ({
          agent: entry.name,
          title: entry.title,
          pid: child.pid ?? null,
          // The agent's cwd, absolute — ACP's `session/new` requires one,
          // and the page is the ACP client, so the page has to have it.
          // A deliberate exception to D22's "names, never paths": that rule
          // protects a client from learning the layout of workspaces it was
          // never granted, and this client is holding a handle to this exact
          // folder. The path is a label for a capability it already has.
          cwd: opts.root,
          argv: [entry.bin, ...entry.args],
          sandboxed: !!sandbox,
          confinement: summary,
          // relative to the shared folder: the page has a handle to it
          profile: sandbox ? path.relative(opts.root, profilePath) : null,
          state: { mode: entry.state.mode, dirs: stateDirs, why: entry.state.why },
          env: Object.keys(env).sort(),
        }),
        /** Everything that did not fit the payload channel. A stalled agent
         *  is diagnosable from the page instead of from the terminal the
         *  demo is trying to replace. */
        "acp/diagnostics": () => ({
          ...counters,
          pendingBytes: splitter.pending,
          exited,
          stderr: [...stderr],
        }),
      },

      onClose: () => {
        if (!exited) {
          child.kill("SIGTERM");
          const t = setTimeout(() => {
            if (!exited) child.kill("SIGKILL");
          }, KILL_GRACE_MS);
          t.unref();
        }
        // The profile outlives nothing: it was this session's policy.
        try {
          if (sandbox) fs.rmSync(profilePath, { force: true });
        } catch {}
      },
    };
  };
}
