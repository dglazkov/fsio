import { type ServicesDoc, type ServiceWorkspace } from "@fsio/common";
/** Leveled line logger (D14). Lines are for humans — machine-readable
 *  state lives in the protocol files and `listSessions()`. Structurally
 *  satisfied by `console`, so `logger: console` just works. */
export interface HostLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/** Read-only session snapshot (D14): what an embedder can see. Aligned
 *  with `SpawnRequestInfo` where the fields overlap. */
export interface SessionInfo {
    id: string;
    /** null until spawn.json has been read. */
    kind: string | null;
    /** free-form client tag from the spec (diagnostics only). */
    client?: string | undefined;
    /** web origin reported by the client (D15) — advisory, display-only. */
    origin?: string | undefined;
    /** adopted → pending (spawn policy, D12) → running → exited | done. */
    phase: SessionPhase;
    /** shell child pid; host pid for in-process kinds. */
    pid?: number;
    /** shell sessions: whether a real pty is attached. */
    pty?: boolean;
    /** host → client bytes appended / acked (flow-control state, D9). */
    bytesOut: number;
    bytesAcked: number;
    /** ms epoch of last uplink activity. */
    lastActivityAt: number;
    /** D17: heartbeat-aware client silent past detachAfterMs — session alive,
     *  awaiting the client's return (or reattach, #3 phase 2). */
    detached: boolean;
    /** ms epoch of the last consumed uplink chunk (presence, D17). */
    lastClientSeenAt: number;
    /** writer epoch (D18): 0 = spawning client, bumped per attach grant. */
    epoch: number;
}
export type SessionPhase = "adopted" | "pending" | "running" | "exited" | "done";
/** What a spawn policy gets to judge, beyond the raw spec: identity plus
 *  the *resolved* command — what would actually run, not what was asked
 *  for (a shell spec with no `cmd` means $SHELL; the hook must see that). */
export interface SpawnRequestInfo {
    sessionId: string;
    /** kind after defaulting ("echo" when the spec names none). */
    kind: string;
    /** true when this is an ATTACH to a live session (D18), not a spawn:
     *  the command already runs; what's being judged is the new client
     *  taking control of it. client/origin are the attacher's. */
    attach?: boolean;
    /** free-form client identification from the spec (diagnostics only —
     *  anything that can write the folder can claim anything; see #6). */
    client?: string | undefined;
    /** web origin reported by the client (D15) — same caveat: advisory,
     *  display-only, never an authorization input. */
    origin?: string | undefined;
    /** hub deployment (D22): the workspace name the spec asked for, after
     *  the resolver accepted it. Absent in one-folder mode. */
    workspace?: string;
    /** shell kinds only: the exact command/args/cwd that would run. `cwd` is
     *  already resolved inside the workspace root when there is one. */
    cmd?: string;
    args?: string[];
    cwd?: string;
    /** whether a real pty would be used (node-pty present and not opted out). */
    pty?: boolean;
}
/** `true`/`false` allow/deny; the object form attaches a client-visible
 *  reason and (rarely) a custom JSON-RPC error code (default 1004). */
export type SpawnDecision = boolean | {
    allow: boolean;
    reason?: string;
    code?: number;
};
/** What a kind handler gets to work with. */
export interface KindContext {
    readonly sessionId: string;
    /** the spawn request's params, as sent (the kind defines their meaning). */
    readonly spec: Readonly<Record<string, unknown>>;
    /** append DATA to the session's out stream (host → client). */
    write(data: Uint8Array | string): void;
    /** report the session as exited (status.json); delivery to the kind
     *  stops. The session dir survives until the client's `close` (D6). */
    exit(exitCode?: number | null): void;
    /** session-prefixed logger. */
    log: HostLogger;
}
/** A live kind session, as returned by its handler. */
export interface KindSession {
    /** extra fields merged into the spawn result the client's `ready` sees. */
    result?: Record<string, unknown>;
    /** client → host DATA frames. */
    onData?: (bytes: Uint8Array) => void;
    /** RPC methods (requests get the return value as the result; throw an
     *  object with `code`/`message` — e.g. common's RpcError — for coded
     *  errors). `ack` and `close` are host-reserved and never dispatched;
     *  an unhandled method falls back to the builtins (`ping`), then
     *  `-32601`. */
    methods?: Record<string, (params: unknown) => unknown | Promise<unknown>>;
    /** teardown: client close, host close(), or idle GC. Not called after
     *  the kind's own exit(). */
    onClose?: () => void;
}
/** Kind handler: runs per spawned session, after the spawn policy allowed
 *  it (D12). May be async; a throw/rejection fails the spawn (`1002`). */
export type KindHandler = (ctx: KindContext) => KindSession | Promise<KindSession>;
/** Spawn policy hook (D12): consulted for every spawn request, every kind.
 *  May return a promise — an async policy IS the confirmation mechanism
 *  (prompt a human, check an allow-list service…); the client just sees
 *  `ready` settle later. A throwing/rejecting policy denies (fail-safe).
 *  Replaces the `allowShell` boolean when provided. */
export type SpawnPolicy = (spec: Readonly<Record<string, unknown>>, info: SpawnRequestInfo) => SpawnDecision | Promise<SpawnDecision>;
/** What the resolver says about a requested workspace name. `root` is an
 *  absolute path that never reaches the wire — the host uses it as the
 *  spawn's base directory and reports only the name. `error` is the
 *  client-visible text of the `1006`, so it must contain no path and must
 *  not enumerate workspaces the client did not name. */
export type WorkspaceResolution = {
    root: string;
    name?: string;
} | {
    error: string;
};
/** Resolves a spawn spec's `workspace` name (D22). Deliberately
 *  synchronous: a registry lookup is a map read, and the resolved root
 *  must be identical for the policy's `info` and for the actual spawn.
 *
 *  The resolver owns "which names exist", "which this client may see",
 *  and "is a name required here" (it knows how many entries the host
 *  serves); the host owns containment of `cwd` and the wire discipline.
 *  It MUST NOT substitute a default for an unresolvable name — the client
 *  would be told it ran somewhere it did not (D22). */
export type WorkspaceResolver = (name: string | undefined, info: SpawnRequestInfo) => WorkspaceResolution;
/** Hub-shaped additions to `services.json` (D24). Every field is a claim
 *  the embedder makes; none of it is discoverable by the library. */
export interface ServicesInput {
    /** capability names beyond the ones the host derives (D25). Unknown to
     *  a client means "not supported", never fatal — so only advertise a
     *  name once the facility behind it works. */
    capabilities?: string[];
    /** advertisable workspaces: **names only**, never paths (D22/D24). One
     *  file serves all tenants, so this is the subset the user marked
     *  advertisable, not the registry. */
    workspaces?: ServiceWorkspace[];
    /** kind names that require a D23 grant before the policy is consulted.
     *  Hub-confined kinds (`echo`, the transport diagnostic) are omitted —
     *  they may be served ungranted. */
    needsGrant?: string[];
    /** per-kind detail, keyed by kind name (D31): transcribed into that
     *  kind's `detail` and interpreted nowhere in this library. Names with no
     *  registered kind are dropped — the document advertises what the host
     *  serves, and detail without a kind is detail about nothing.
     *
     *  The privacy line of D24 applies and the library cannot enforce it:
     *  one file serves every granted origin, so an embedder putting paths or
     *  secrets in here has leaked them to all of them. */
    kindDetail?: Record<string, Record<string, unknown>>;
    /** the consent endpoint, published only while a host serves one. */
    consent?: {
        url: string;
    };
}
/** Every time-based host behavior, injectable so tests can run them at
 *  short timescales (TESTING.md: "become testable when #17 makes the
 *  intervals injectable"). Defaults are the measured/spec'd values. */
export interface HostTimings {
    /** host.json heartbeat cadence (spec: liveness = mtime < 3 beats). */
    heartbeatMs?: number;
    /** slow safety poll backing up fs.watch. */
    safetyPollMs?: number;
    /** how long traffic keeps the hot poll armed (D4's gate, host-side —
     *  F22). The browser client's window is 2 s; matching it keeps the two
     *  sides' idle economics comparable. */
    hotWindowMs?: number;
    /** idle echo sessions are reaped after this long (workbench artifacts; #3). */
    idleGcMs?: number;
    /** how often the idle sweep runs. */
    idleSweepMs?: number;
    /** heartbeat-aware sessions whose client has been silent this long are
     *  detached (echo: reaped) — D17. Must exceed the browser's 1/min
     *  background timer clamp with margin (F16). */
    detachAfterMs?: number;
    /** stale exited sessions older than this are GC'd on adoption (spec: Session lifecycle). */
    staleGraceMs?: number;
    /** delay before deleting a closed session dir (lets the client stop watchers). */
    closeDelayMs?: number;
    /** fast retry when an uplink chunk looks torn/empty (invariant 3, F11). */
    retryMs?: number;
    /** close(): how long children get after SIGTERM before SIGKILL (D14). */
    killGraceMs?: number;
}
/** How much of the past to keep (D26 rule 4). Both bounds are enforced
 *  when a transcript is archived and again at start, so lowering them takes
 *  effect on the next run rather than at the next rotation. The newest
 *  transcript is never swept: deleting the conversation the human just
 *  ended is the one outcome worse than keeping too much. */
export interface TranscriptRetention {
    /** how many ended sessions to keep, newest first. Default 10. */
    keep?: number;
    /** total bytes across kept transcripts. Default 32 MB — four full head
     *  segments (`segMax`), which is a lot of chat and not a lot of disk. */
    maxBytes?: number;
}
/** Flow control knobs (spec: segmented out log + ack window). */
export interface HostLimits {
    /** rotate out segment at this size. */
    segMax?: number;
    /** pause output when unacked bytes exceed this. */
    ackWindow?: number;
    /** resume when unacked drops below this. */
    ackResume?: number;
}
export interface HostServerOptions {
    /** the shared directory (the one the browser picks); `.fsio` lives inside. */
    root: string;
    /** permit `kind: "shell"` sessions (spawns processes!). Default false.
     *  Sugar for the static default policy; ignored when `onSpawnRequest`
     *  is provided. */
    allowShell?: boolean;
    /** spawn policy hook (D12); overrides `allowShell`. */
    onSpawnRequest?: SpawnPolicy;
    /** workspace resolver (D22): turns a spec's `workspace` name into the
     *  root a process-spawning session runs in. Omitted = the one-folder
     *  case, a registry of one (see `workspaceName`). */
    workspaces?: WorkspaceResolver;
    /** the name a one-folder host answers to for its own shared directory
     *  (D22: "a registry of one"). Default: none — an omitted `workspace`
     *  means the shared dir, and any name gets `1006`, because a host that
     *  advertises no name can resolve none. Ignored when `workspaces` is
     *  provided. */
    workspaceName?: string;
    /** the embedder's half of the service directory (D24) — advertisable
     *  workspace names, extra capability names, the consent endpoint. May be
     *  replaced at runtime with `setServices()`. */
    services?: ServicesInput;
    /** wipe .fsio on startup. Default false. Refused while another host is
     *  live on the directory (#40) — takeover applies here too. Transcript
     *  retention, when on, survives it (D26 rule 4). */
    fresh?: boolean;
    /** keep ended sessions' out logs under `.fsio/transcripts/<id>/` instead
     *  of deleting them with the session dir (D26 rule 4, #119). Default off
     *  — an embedder whose sessions carry a *conversation* opts in, and by
     *  opting in accepts that the record outlives the host that wrote it. */
    transcripts?: boolean | TranscriptRetention;
    /** skip the live-host refusal (#40): seize a directory whose host.json
     *  still looks live — for a killed host whose last heartbeat hasn't gone
     *  stale yet. Default false. */
    takeover?: boolean;
    /** use fs.watch wakeups. Default true. */
    watch?: boolean;
    /** ensure `.fsio/` is git-ignored when the shared directory lies inside
     *  a git repository (#82: the out log is full scrollback and must never
     *  reach version control). Default true. */
    gitignore?: boolean;
    /** hot-poll interval while traffic is flowing (default 5, 0 = off; F2).
     *  Gated on recent traffic, not session liveness — see `timings.hotWindowMs`
     *  and markActive() (F22). */
    hotPollMs?: number;
    /** unconditional poll loop interval (default 0 = off). */
    pollMs?: number;
    logger?: HostLogger;
    /** pty provider (D14): a PtyModule to use, or `false` to force the pipe
     *  fallback. Default: auto-load node-pty if installed. */
    pty?: PtyModule | false;
    timings?: HostTimings;
    limits?: HostLimits;
}
export interface PtyProcess {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: {
        exitCode: number;
    }) => void): void;
}
export interface PtyModule {
    spawn(file: string, args: string[], opts: {
        name: string;
        cols: number;
        rows: number;
        cwd: string;
        env: Record<string, string | undefined>;
    }): PtyProcess;
}
export declare class HostServer {
    readonly sharedDir: string;
    readonly fsioDir: string;
    readonly sessionsDir: string;
    /** where ended sessions' out logs are kept when retention is on (#119). */
    readonly transcriptsDir: string;
    readonly allowShell: boolean;
    private readonly onSpawnRequest;
    private readonly workspaces;
    readonly watchEnabled: boolean;
    readonly hotPollMs: number;
    readonly pollMs: number;
    readonly timings: Required<HostTimings>;
    readonly limits: Required<HostLimits>;
    readonly log: HostLogger;
    /** true once node-pty was found at start(). */
    ptyAvailable: boolean;
    private fresh;
    /** null = off, and off means an ended session leaves nothing behind. */
    private readonly transcripts;
    private readonly takeover;
    private readonly gitignore;
    private readonly ptyOpt;
    private ptyMod;
    private sessions;
    private kinds;
    private timers;
    private hotTimer;
    private lastTraffic;
    private pendingCleanups;
    private rootWatcher;
    private hbSeq;
    private startedAt;
    private running;
    private servicesInput;
    private servicesBody;
    private servicesRev;
    private readonly namedWorkspaces;
    private scanning;
    private rescan;
    constructor(opts: HostServerOptions);
    /** Read-only view of the sessions this host is serving (D14): the
     *  introspection surface for confirmation UIs (#16) and reattach (#3).
     *  Snapshots — mutating them changes nothing. */
    listSessions(): SessionInfo[];
    /** Register a session kind (D13): `handler` runs per allowed spawn of
     *  this kind and returns the session's behavior (DATA sink, RPC methods,
     *  teardown). Register before clients spawn; names are first-come. */
    registerKind(kind: string, handler: KindHandler): this;
    /** Replace the embedder's half of the service directory and republish.
     *  Idempotent and cheap: the document is temp+renamed *only* when its
     *  content actually changes, and only then does `rev` move. fsiod calls
     *  this when the workspace registry changes — `fsio share` must reach a
     *  page without a daemon restart, the same "it bites at the next
     *  judgment" discipline D23 requires of revocation. */
    setServices(input: ServicesInput): this;
    /** The document as this host would publish it right now (D24) — the
     *  introspection surface, and what the tests read. */
    services(): ServicesDoc;
    private buildServices;
    /** Write `services.json` if — and only if — its content changed, and ring
     *  the doorbell (`servicesRev` in `host.json`) when it did. Returns true
     *  on a revision bump. */
    private publishServices;
    private readServices;
    private republish;
    /** Attach to the shared dir and begin serving. Resolves after the first
     *  heartbeat is on disk (host.json presence = readiness, per spec). */
    start(): Promise<this>;
    /** Traffic gate for the hot poll (D4, ported host-side — F22). fs.watch
     *  wakeups ride FSEvents at ~50 ms on macOS (F2), too slow for a live
     *  uplink, so traffic arms a fast scan loop; `hotWindowMs` of silence
     *  disarms it and the per-dir watchers plus the 250 ms safety scan carry
     *  the idle case (invariant 1). The old gate was session *liveness*
     *  (`started && !done`), which is not the same claim: N idle-but-running
     *  sessions kept the 5 ms × O(N) loop hot forever — F22 measured ~60% of
     *  a core at 32 idle sessions, against ~3% for the same machinery
     *  idle-gated (cells A vs B), and ~10% vs ~0.6% at one. Wake-from-idle
     *  costs a watch event (~50 ms) or a safety scan (≤250 ms); the first
     *  consumed chunk re-arms the loop. */
    private markActive;
    /** Stop serving: kill session processes, release watchers and timers,
     *  retract host.json (peers read absence/staleness as host-gone). All of
     *  that happens synchronously — un-awaited calls still fully tear down.
     *  The returned promise resolves once every child has actually exited
     *  (SIGTERM, then SIGKILL after `timings.killGraceMs` — D14), so
     *  embedders can `await host.close()` for a clean process exit. */
    close(): Promise<void>;
    private reapChild;
    private refuseLiveHost;
    private ensureGitignore;
    private watchDir;
    private heartbeat;
    private idleSweep;
    private sweepClientDirs;
    private archiveTranscript;
    /** Enforce the retention bounds, newest first. Runs after every archive
     *  and once at start — a cap lowered between runs takes effect then,
     *  which is the only moment it can: nothing sweeps while no host runs. */
    private sweepTranscripts;
    /** Delete the service directory, keeping what outlives the host that
     *  wrote it. `fresh: true` runs this at start; an embedder runs it at
     *  Ctrl-C — the two moments that used to `rm -rf .fsio` and take the
     *  transcripts with it (#119). With retention off and `keepClient` false
     *  it is exactly that `rm -rf`; otherwise the survivors below stay, and a
     *  `.fsio` left holding nothing removes itself so a folder that hosted no
     *  conversation is still handed back pristine (D6).
     *
     *  `keepClient` spares `client/`, which is the one directory under
     *  `.fsio` the host does not own: pages write their own diagnostics there
     *  and nothing in the protocol reads them (spec layout, D6's amendment
     *  for [#109](https://github.com/dglazkov/fsio/issues/109)). Sweeping it
     *  is the host cleaning up after a party it was not at — and in a
     *  manually-driven cooperative run it destroys the verdicts *as the
     *  gesture that ends the run*, which is how #102's first run lost them.
     *
     *  It is a parameter rather than a constant because the two call sites
     *  want opposite answers. At shutdown the reports are the point. At
     *  `fresh` start they are the previous run's, and carrying them forward
     *  would make "read the newest dir under `client/`" — the whole
     *  cooperative-verification contract — quietly unreliable. */
    cleanServiceDir(keepClient?: boolean): void;
    scheduleScan(): void;
    private runScan;
    private scanOnce;
    private adoptSession;
    private tryStart;
    private defaultPolicy;
    private consultPolicy;
    private decideAndStart;
    private startKind;
    /** Hub deployment (D22): resolve the spec's `workspace` name to the root
     *  the child will run in, or refuse the session with `1006` and return
     *  null. `1006` covers unresolvable, may-not-see, and omitted-where-
     *  required alike — the client's next move (name a workspace it can
     *  have) is the same for all three. One-folder hosts have no resolver:
     *  the shared directory is the root, as it always was. */
    private resolveWorkspace;
    /** The exact thing a shell spec would run — shared by the policy hook's
     *  info and startShell so the judged command can't drift from the
     *  executed one (#6: "display the exact spawn.json before honoring it").
     *  `root` is the resolved workspace root (D22), or the shared directory
     *  in one-folder mode. */
    private resolveShell;
    /** Write to a pty without losing the end of it.
     *
     *  A terminal's input queue is a fixed buffer in the line discipline, and
     *  when it is full the kernel **discards** what does not fit rather than
     *  blocking the writer. Nothing reports that: `write` returns void, node-pty
     *  offers no drain, and the bytes are simply not there. An extension that
     *  wrote a script in one call got a shell that ran the first third of it and
     *  stopped, with no error anywhere (#210).
     *
     *  Measured on macOS, `/bin/sh` on a real pty, one `write` per burst:
     *
     *      1,070 bytes        60 of 60 lines
     *      1,160 bytes        61 of 65
     *      3,690 bytes        83 of 200   (child at a prompt)
     *      3,690 bytes        66 of 200   (child in `sleep 2`)
     *      15,090 bytes       78 of 800
     *
     *  The survivor count plateaus around 66 regardless of how much is written,
     *  which is the signature of a fixed queue rather than of a slow reader.
     *
     *  So: never hand the line discipline more than it holds. Chunks go out
     *  under the limit, one per tick, and the same burst then arrives whole —
     *  3,690 bytes measured at 200 of 200 with the child reading. A burst that
     *  arrives while the child reads nothing at all is still lost after the
     *  first chunk-full, and no amount of pacing changes that (measured: 65 of
     *  200 at every chunk size and delay tried). That residue is a property of
     *  driving a terminal programmatically, and the way out of it is an
     *  operation that runs a command and captures its output rather than a
     *  keyboard — which is #210's open question, not something this can fix.
     *
     *  Keystrokes are unaffected: anything that fits in one chunk is written
     *  immediately, on this tick, with no timer involved. */
    private toPty;
    private startShell;
    private processAttach;
    private decideAttach;
    private processIncoming;
    private handleFrame;
    private handleRpc;
    private removeSessionDir;
}
//# sourceMappingURL=host-server.d.ts.map