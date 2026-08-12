// fsio client library (v0).
//
// Transport asymmetry (deliberate, see spec/DECISIONS.md D2):
//   host -> client: append-only framed log (sessions/<id>/out.log); client
//     reads from a byte offset on each wakeup.
//   client -> host: numbered chunk files (sessions/<id>/in/NNNNNNNN.f);
//     FsWritable commits atomically on close(). The host consumes chunks
//     in order and deletes them.
//
// API shape (spec/DECISIONS.md D11):
//   - construction is synchronous; every event has a listener-attachment
//     window before any I/O can fire; init failures reject `ready`.
//   - events over constructor callbacks: on(type, fn) => unsubscribe.
//   - the FS surface is structural (./fs.ts): real FileSystemDirectoryHandle
//     in the browser, an fs shim in Node (TESTING.md B1).
import { FrameType, encodeFrame, jsonFrame, decodeJson, parseFrames, concatBytes, now, chunkName, dirChunkName, DIR_CHUNK_MAX_BYTES, RpcEndpoint, RpcError, RpcErrors, rpcRequest, rpcNotification, SPAWN_REQUEST_ID, } from "@fsio/common";
// RpcErrors rides along with RpcError: D10 makes coded errors part of the
// client-facing contract, so consumers need the codes without a second
// dependency on @fsio/common.
export { FrameType, jsonFrame, decodeJson, now, RpcError, RpcErrors };
export const hasObserver = "FileSystemObserver" in globalThis;
// Backoff schedule for uplink commit retries (#37). Bounded: after these
// are exhausted the failure surfaces as a transport error.
const COMMIT_RETRY_MS = [10, 50, 250, 1000];
// Dirname-lane self-defense (#4): the fast lane exploits a non-contractual
// Chrome asymmetry (F10: directory creation skips the after-write scan
// that costs a file close() ~65-80 ms, F7). Real traffic doubles as the
// probe — every commit is timed, spawn.json/attach.json seed the file-lane
// baseline before any chunk flows — and in auto mode the lane is abandoned
// when it stops earning its keep:
//   slow (reversible): DIR_LANE_SLOW_STREAK consecutive dir commits above
//     DIR_LANE_SLOW_MS *and* no longer meaningfully faster than the file
//     baseline (the comparative guard keeps a uniformly slow filesystem —
//     where the lane still wins — from tripping it). Re-probed with one
//     real small batch after DIR_LANE_REPROBE_MS.
//   broken (for the session): a dir commit failed where the same bytes
//     then landed as a file chunk (name-length limits, filesystem quirks) —
//     DIR_LANE_BROKEN_STRIKES such fallbacks latch it off.
const DIR_LANE_SLOW_MS = 25;
const DIR_LANE_SLOW_STREAK = 3;
const DIR_LANE_REPROBE_MS = 60_000;
const DIR_LANE_BROKEN_STRIKES = 2;
const LANE_EWMA_ALPHA = 0.3;
// Bound on FileSystemObserver.observe() settling (F19): a first-use
// observe() was measured stalling ~49 s (Chrome 150, first session after a
// fresh grant) — no rejection, so the D7 refusal path never fired, and the
// stall gated `ready` (and the uplink behind it) while the host's spawn
// answer sat on disk. Past this bound the notifier downgrades to polling.
const OBSERVE_SETTLE_MS = 2000;
const ewma = (prev, sample) => prev === undefined ? sample : prev * (1 - LANE_EWMA_ALPHA) + sample * LANE_EWMA_ALPHA;
const errName = (e) => (e instanceof DOMException || e instanceof Error ? e.name : "Error");
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
// Wrap an FS operation so failures say WHAT we were doing, not just Chrome's
// terse DOMException ("The object can not be modified in this way").
export async function op(label, fn) {
    try {
        return await fn();
    }
    catch (e) {
        const err = new Error(`${label}: ${errName(e)}: ${errMsg(e)}`);
        err.cause = e;
        throw err;
    }
}
export class FsioClient {
    root;
    fsioDir;
    sessionsDir;
    /** last-read service directory, refreshed when `servicesRev` moves (D24). */
    servicesDoc = null;
    constructor(rootHandle) {
        this.root = rootHandle;
    }
    async connect() {
        this.fsioDir = await op("opening .fsio/", () => this.root.getDirectoryHandle(".fsio", { create: true }));
        this.sessionsDir = await op("opening .fsio/sessions/", () => this.fsioDir.getDirectoryHandle("sessions", { create: true }));
        return this.hostInfo();
    }
    /** Reads host.json; returns {alive, info, ageMs} */
    async hostInfo() {
        try {
            const fh = await this.fsioDir.getFileHandle("host.json");
            const f = await fh.getFile();
            const info = JSON.parse(await f.text());
            const ageMs = Date.now() - f.lastModified;
            return { alive: ageMs < 6000, ageMs, info };
        }
        catch {
            return { alive: false, ageMs: Infinity, info: null };
        }
    }
    /** Read the service directory (D24): what this host can do, which kinds
     *  it serves, and the workspace **names** it advertises (never paths).
     *
     *  The doorbell is `host.json`'s `servicesRev` (D3's hot-pointer/cold-state
     *  split): a client already statting the heartbeat passes that revision
     *  here and gets its cached copy back untouched unless the number moved.
     *  Feature-detect on `capabilities` names, not on `protocol` ranges, and
     *  treat an unknown name as "not supported", never as an error (D25). */
    async services(rev) {
        if (rev !== undefined && this.servicesDoc && this.servicesDoc.rev === rev)
            return this.servicesDoc;
        try {
            const fh = await this.fsioDir.getFileHandle("services.json");
            const doc = JSON.parse(await (await fh.getFile()).text());
            // A host that publishes no service directory is not an error, and
            // neither is a torn read — both mean "ask again later" (invariant 3).
            if (!doc || typeof doc !== "object")
                return null;
            this.servicesDoc = doc;
            return doc;
        }
        catch {
            return null;
        }
    }
    /** Sugar for the D25 handshake: is this capability name advertised? */
    async hasCapability(name, rev) {
        const doc = await this.services(rev);
        return !!doc && Array.isArray(doc.capabilities) && doc.capabilities.includes(name);
    }
    /** Synchronous by design (D11): the caller gets a listener-attachment
     *  window before any event can possibly fire. All async init failures
     *  (folder creation, spawn.json commit) reject `session.ready`. */
    createSession(spec, opts = {}) {
        if (!this.sessionsDir)
            throw new Error("createSession before connect()");
        const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return new FsioSession(id, this.sessionsDir, spec, opts);
    }
    /** Enumerate sessions in the shared dir (D18 discovery) — read-only, the
     *  reattach picker's data source. `status.detached` marks orphans;
     *  `status.writer` names the current uplink owner. */
    async listSessions() {
        if (!this.sessionsDir)
            throw new Error("listSessions before connect()");
        const out = [];
        for await (const name of this.sessionsDir.keys()) {
            if (!name.startsWith("s-"))
                continue;
            try {
                const dir = await this.sessionsDir.getDirectoryHandle(name);
                const readJson = async (f) => JSON.parse(await (await (await dir.getFileHandle(f)).getFile()).text());
                const entry = { id: name, kind: null, status: null };
                try {
                    // spawn.json carries the JSON-RPC spawn request; legacy bare specs
                    // have the fields at the top level.
                    const spawn = (await readJson("spawn.json"));
                    const p = (spawn.params ?? spawn);
                    entry.kind = p.kind ?? "echo";
                    entry.client = p.client;
                    entry.origin = p.origin;
                }
                catch { }
                try {
                    entry.status = (await readJson("status.json"));
                }
                catch { }
                out.push(entry);
            }
            catch { } // dir vanished mid-scan (host GC) — skip
        }
        return out;
    }
    /** Attach to an existing session (D18). Semantics: TAKEOVER — the grant
     *  bumps the writer epoch, moves the uplink to `in.<epoch>/`, and fences
     *  the previous client (it observes `writer` in status.json and stops
     *  sending). `replay: true` re-emits the head segment's DATA frames
     *  (scrollback) before live output. `ready` resolves with the
     *  AttachResult (kind, pid, epoch, …) or rejects with a coded RpcError
     *  (1005 exited, 1001/1004 policy denial). */
    attachSession(sessionId, opts = {}) {
        if (!this.sessionsDir)
            throw new Error("attachSession before connect()");
        return new FsioSession(sessionId, this.sessionsDir, null, opts, { replay: opts.replay ?? false, client: opts.client });
    }
}
export class FsioSession {
    id;
    pollMs;
    uplink;
    safetyMs;
    heartbeatMs;
    /** Resolves with the spawn result; rejects with RpcError on spawn failure
     *  (and with the underlying error on init failure). */
    ready;
    stats = {
        chunksWritten: 0,
        dirChunks: 0,
        fileChunks: 0,
        bytesIn: 0,
        bytesOut: 0,
        wakeups: 0,
    };
    /** Effective notifier mode; may downgrade at init (observer refusal, D7). */
    get mode() {
        return this.#mode;
    }
    get status() {
        return this.#status;
    }
    get closed() {
        return this.#closed;
    }
    /** Writer epoch this client owns (D18): 0 = spawning client; attachers
     *  get theirs from the grant. A higher epoch in status.json means this
     *  client has been superseded. */
    get epoch() {
        return this.#epoch;
    }
    #mode;
    #status = null;
    #dir;
    #inDir;
    #initDone;
    /** gates #pump: init for spawned sessions; the full grant + setup for
     *  attached ones (no uplink lane exists before the epoch is known). */
    #uplinkReady;
    #epoch = 0;
    #attach = null;
    /** the grant expectation for the aid whose bootstrap commit actually
     *  landed (#116) — set by #initAttach, awaited by `ready`. */
    #granted = null;
    /** non-null while attaching: live frames buffered until grant + replay
     *  have run, so replayed scrollback precedes them. */
    #hold = null;
    #listeners = new Map();
    #gen = 0; // current out segment being read
    #offset = 0; // consumed bytes within current segment
    #cumConsumed = 0; // cumulative bytes consumed across segments
    #lastAckTotal = 0;
    #lastAckAt = 0;
    #outSeq = 1; // next chunk number to write
    // Dirname-lane health (#4; auto mode only — forced lanes are for labs).
    #dirLane = "on";
    #dirLaneSlowMs;
    #dirLaneReprobeMs;
    #dirLaneSince = 0; // when "slow" latched; gates the re-probe
    #dirSlowStreak = 0;
    #dirLaneStrikes = 0;
    #queue = []; // encoded frames awaiting commit
    #pumping = false;
    #reading = false;
    #readAgain = false;
    #closed = false;
    #pumpError = null; // first async send failure; surfaced via "error" + next send()
    // Control plane: JSON-RPC over RPC frames (spec D10). One endpoint per
    // session owns id correlation; responses are consumed in #drainSegment.
    #rpc;
    #observeSettleMs;
    #observer = null;
    #pollTimer;
    #hotTimer = null;
    #safetyTimer;
    #heartbeatTimer;
    #lastActivity = 0;
    #wakeFn;
    constructor(id, sessionsDir, spec, opts = {}, attach) {
        const { mode = "auto", pollMs = 15, uplink = "auto", safetyMs = 500, heartbeatMs = 20_000, uplinkLane = {}, observeSettleMs = OBSERVE_SETTLE_MS } = opts;
        this.#dirLaneSlowMs = uplinkLane.slowMs ?? DIR_LANE_SLOW_MS;
        this.#dirLaneReprobeMs = uplinkLane.reprobeMs ?? DIR_LANE_REPROBE_MS;
        this.#observeSettleMs = observeSettleMs;
        // D15: a web-page client reports its origin — stamped HERE, overriding
        // caller-supplied values, so a page cannot claim a foreign origin
        // through this API. (It can still write spawn.json by hand: the field
        // stays advisory and hosts must treat it as display-only — spec
        // "Session kinds".) Node embedders have no `location`; absent = absent.
        const webOrigin = globalThis.location?.origin;
        if (spec && typeof webOrigin === "string")
            spec = { ...spec, origin: webOrigin };
        this.id = id;
        this.pollMs = pollMs;
        this.safetyMs = safetyMs;
        this.heartbeatMs = heartbeatMs;
        // uplink "auto": small frame batches ride the dirname fast lane (≤80ms
        // → ~3ms measured, spec/FINDINGS.md F10 — directory creation skips
        // Chrome's after-write scan); big batches fall back to file chunks.
        // "file" forces file chunks. Auto also probes lane health (#4).
        this.uplink = uplink;
        if (uplink === "auto")
            this.stats.dirLane = "on";
        // Notifier modes (spec/FINDINGS.md F6, refined by the observer lab):
        //   adaptive (default) — observer as idle sentinel (Chrome delivers on a
        //     ~300ms cadence: fine for waking up, useless for streams) + hot poll
        //     only while traffic flowed in the last 2s. Interactive latency of
        //     polling, idle cost of observers.
        //   hybrid — observer + always-on hot poll. poll — polling only.
        //   observer — observer only (for science).
        this.#mode = mode === "auto" ? (hasObserver ? "adaptive" : "poll") : mode;
        this.#rpc = new RpcEndpoint((msg) => this.sendJson(FrameType.RPC, msg));
        if (attach) {
            // Attach mode (D18): the request rides attach.<aid>.json (bootstrap
            // file, like spawn.json); the grant arrives on the out stream we are
            // already reading. Only after the grant is there an uplink lane.
            const params = { aid: "" }; // aid is set per attempt (#116)
            if (attach.client !== undefined)
                params.client = attach.client;
            if (typeof webOrigin === "string")
                params.origin = webOrigin; // D15, same stamping rule
            this.#attach = { replay: attach.replay, aid: "", params, replayTo: null };
            this.#initDone = this.#initAttach(sessionsDir);
            // The grant expectation is registered per attempt inside #initAttach
            // (each retry carries a fresh aid), so it can only be awaited once
            // init has settled on one.
            this.ready = this.#initDone
                .then(() => this.#granted)
                .then(async ({ result }) => {
                await this.#completeAttach(result);
                return result;
            });
            this.#uplinkReady = this.ready.then(() => { });
            this.#uplinkReady.catch(() => { });
        }
        else {
            // Register the pending spawn id before spawn.json exists so the host's
            // answer can't race us; park it until init has committed the request.
            const spawned = this.#rpc.expect(SPAWN_REQUEST_ID);
            spawned.catch(() => { }); // settled via `ready`; never an unhandled rejection
            this.#initDone = this.#init(sessionsDir, spec);
            this.ready = this.#initDone.then(() => spawned).then(({ result }) => result);
            // Sends may flow before `ready` (they queue in in/ and drain on
            // approval — spec: spawn bootstrap), so the uplink gates on init only.
            this.#uplinkReady = this.#initDone;
        }
        this.ready.catch(() => { }); // surfacing is the awaiter's job, not the console's
    }
    /** Subscribe; returns the unsubscribe function (disposal, D11). All
     *  listeners are dropped on close(). */
    on(type, listener) {
        let set = this.#listeners.get(type);
        if (!set)
            this.#listeners.set(type, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
    }
    #emit(type, ...args) {
        const set = this.#listeners.get(type);
        if (!set?.size) {
            // An unobserved transport failure must not vanish: rethrow on a fresh
            // stack so window.onerror / uncaughtException sees it.
            if (type === "error")
                setTimeout(() => { throw args[0]; }, 0);
            return;
        }
        for (const fn of [...set]) {
            try {
                fn(...args);
            }
            catch (e) {
                // A throwing listener must not lose frames or kill the drain loop
                // (D11): route to "error"; if *that* listener throws, fresh stack.
                const err = e instanceof Error ? e : new Error(String(e));
                if (type === "error")
                    setTimeout(() => { throw err; }, 0);
                else
                    this.#emit("error", err);
            }
        }
    }
    async #init(sessionsDir, spec) {
        this.#dir = await op(`creating session folder ${this.id}`, () => sessionsDir.getDirectoryHandle(this.id, { create: true }));
        this.#inDir = await op(`creating session ${this.id}/in/`, () => this.#dir.getDirectoryHandle("in", { create: true }));
        // spawn.json is written last: its appearance signals a complete session.
        // It carries a JSON-RPC spawn *request*; the host answers on the out
        // stream, so spawn failures arrive as real error objects (code,
        // message) instead of a status.json state to poll for.
        //
        // Retrying the SAME file is idempotent (#116, and the same reasoning as
        // #commitChunk's same-seq retry): the host reads spawn.json and never
        // deletes it, and `tryStart` is guarded by `if (!s.started)`. So either
        // the first commit was never visible and the retry is the only start, or
        // it landed and the guard refuses a second one.
        const bytes = new TextEncoder().encode(JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec)));
        await this.#commitBootstrap("spawn.json", () => this.#writeFile("spawn.json", bytes));
        await this.#startNotifier();
    }
    /** Bootstrap commits are file-lane writes on the critical path with no
     *  pump behind them, and Chrome aborts `close()` mid-stream often enough
     *  to have its own finding (#37: `AbortError: Aborted due to security
     *  policy`). spec/PROTOCOL.md's "retry with bounded backoff" rule was
     *  written for chunks and left these exposed — one abort killed a reattach
     *  to a live session in the field (#115/#116).
     *
     *  `attempt` re-runs the whole commit, so callers that must vary something
     *  per try (attach's aid) do it inside the closure. */
    async #commitBootstrap(what, attempt) {
        for (let i = 0;; i++) {
            try {
                await attempt();
                return;
            }
            catch (e) {
                if (i >= COMMIT_RETRY_MS.length || this.#closed)
                    throw e;
                this.stats.commitRetries = (this.stats.commitRetries ?? 0) + 1;
                this.#emit("note", `retrying ${what} after a transient commit failure (${e instanceof Error ? e.message : String(e)})`);
                await new Promise((r) => setTimeout(r, COMMIT_RETRY_MS[i]));
            }
        }
    }
    async #initAttach(sessionsDir) {
        const a = this.#attach;
        // create: false semantics — attaching to a session that is gone must
        // reject `ready`, not conjure an empty dir the host would adopt.
        this.#dir = await op(`opening session ${this.id}`, () => sessionsDir.getDirectoryHandle(this.id));
        // Position at the current head: everything before it is the previous
        // client's history (optionally replayed, below, once the grant lands).
        try {
            const fh = await this.#dir.getFileHandle("out.sig");
            const sig = JSON.parse(await (await fh.getFile()).text());
            this.#gen = sig.gen;
            this.#offset = sig.size;
            this.#cumConsumed = sig.total;
            this.#lastAckTotal = sig.total;
            if (a.replay)
                a.replayTo = { gen: sig.gen, end: sig.size };
        }
        catch { } // no out.sig yet: brand-new stream, position 0/0
        this.#hold = []; // buffer live frames so replayed scrollback precedes them
        // Unlike spawn.json, an attach retry must carry a FRESH aid (#116). The
        // host unlinks attach.<aid>.json *before* deciding — that delete is its
        // consumption ack — so a same-aid retry after a "landed but still threw"
        // abort yields a second grant and a second epoch bump, and this client,
        // still writing to in.<first epoch>/, would read the higher epoch out of
        // status.json and fence itself. Fresh aids cannot collide: a superseded
        // attempt's grant resolves an expectation nobody awaits, and the epoch
        // this client uses is whichever attempt it is actually waiting on. The
        // host's own comment prescribes exactly this ("it retries with a fresh
        // aid").
        await this.#commitBootstrap("the attach request", async () => {
            a.aid = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            a.params.aid = a.aid;
            // Registered BEFORE the commit so the host's answer cannot race us.
            const granted = this.#rpc.expect(`attach:${a.aid}`);
            granted.catch(() => { }); // settled via `ready`; never an unhandled rejection
            this.#granted = granted;
            await this.#writeFile(`attach.${a.aid}.json`, new TextEncoder().encode(JSON.stringify(rpcRequest(`attach:${a.aid}`, "attach", a.params))));
        });
        await this.#startNotifier();
    }
    async #completeAttach(result) {
        this.#epoch = result.epoch;
        this.#inDir = await op(`creating session ${this.id}/in.${result.epoch}/`, () => this.#dir.getDirectoryHandle(`in.${result.epoch}`, { create: true }));
        const a = this.#attach;
        if (a.replayTo) {
            // Bracket the re-emission so a consumer can tell history from live
            // traffic (#113). Unconditional inside the branch: a session with an
            // empty head still gets start/end, so "did replay happen" is one
            // question and "was there anything in it" is another.
            this.#emit("replay", "start", a.replayTo.gen);
            await this.#replayHead(a.replayTo.gen, a.replayTo.end);
            this.#emit("replay", "end", a.replayTo.gen);
        }
        const held = this.#hold ?? [];
        this.#hold = null;
        for (const [f, at] of held) {
            this.#emit("frame", f, at);
            if (f.type === FrameType.DATA)
                this.#emit("data", f.payload);
        }
        // A takeover that raced our attach window: the status stream is
        // deduped, so a writer record observed (and skipped) during the hold
        // will not re-emit — judge it now, against the granted epoch.
        if (this.#status)
            this.#maybeFence(this.#status);
    }
    // Scrollback replay (D18): re-read the head segment [0, end) and emit its
    // DATA frames. Client-local — the host is not involved. RPC frames are
    // NEVER replayed: they are the previous writer's control traffic, and
    // its response ids could collide with this endpoint's live requests.
    async #replayHead(gen, end) {
        if (end <= 0)
            return;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const fh = await this.#dir.getFileHandle(`out.${String(gen).padStart(8, "0")}.log`);
                const bytes = new Uint8Array(await (await fh.getFile()).slice(0).arrayBuffer()).subarray(0, end);
                const { frames } = parseFrames(bytes);
                const at = now();
                for (const f of frames) {
                    if (f.type !== FrameType.DATA)
                        continue;
                    this.#emit("frame", f, at);
                    this.#emit("data", f.payload);
                }
                return;
            }
            catch {
                await new Promise((r) => setTimeout(r, 50)); // F11-transient snapshot
            }
        }
        this.#emit("note", "scrollback replay unavailable (head segment unreadable)");
    }
    async #writeFile(name, bytes, dir = this.#dir) {
        return op(`committing ${name}`, async () => {
            const t0 = performance.now();
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(bytes);
            await w.close(); // atomic commit point
            // Every file commit (spawn.json, attach.json, chunks) samples the
            // file-lane baseline (#4) — the comparative guard's denominator.
            this.stats.fileCommitMs = ewma(this.stats.fileCommitMs, performance.now() - t0);
        });
    }
    // ---------------- outgoing (client -> host)
    /** Enqueue a frame; frames queued while a commit is in flight are batched
     *  into a single chunk file. Commits are strictly serialized. */
    send(type, payload) {
        this.#enqueue(type, payload);
        this.#markActive(); // user input → replies are coming; be ready for them
    }
    #enqueue(type, payload) {
        if (this.#pumpError)
            throw this.#pumpError;
        this.#queue.push(encodeFrame(type, payload));
        void this.#pump();
    }
    sendJson(type, obj) {
        this.send(type, new TextEncoder().encode(JSON.stringify(obj)));
    }
    sendData(text) {
        this.send(FrameType.DATA, new TextEncoder().encode(text));
    }
    /** JSON-RPC request to the host; resolves {result, rx}. */
    request(method, params, opts) {
        return this.#rpc.request(method, params, opts);
    }
    /** JSON-RPC notification (fire-and-forget: resize, ack, close…). */
    notify(method, params) {
        this.#rpc.notify(method, params);
    }
    /** Uncommitted uplink chunks in this writer's in-dir (labs; #4). */
    async uplinkBacklog() {
        await this.#uplinkReady;
        let n = 0;
        for await (const _ of this.#inDir.keys())
            n++;
        return n;
    }
    async #pump() {
        if (this.#pumping)
            return;
        this.#pumping = true;
        try {
            // Sends may be queued while init (or an attach grant, D18) is in
            // flight; a superseded writer must stop committing entirely (F8).
            try {
                await this.#uplinkReady;
            }
            catch (e) {
                // A failed attach is already surfaced through `ready` — record it
                // so send() throws, but don't re-raise it as a transport error.
                this.#pumpError = e instanceof Error ? e : new Error(String(e));
                this.#queue.length = 0;
                return;
            }
            while (this.#queue.length > 0 && !this.#closed && !this.#pumpError) {
                const batch = concatBytes(this.#queue.splice(0));
                await this.#commitChunk(batch);
                this.stats.chunksWritten++;
                this.stats.bytesOut += batch.length;
            }
        }
        catch (e) {
            this.#pumpError = e instanceof Error ? e : new Error(String(e));
            this.#emit("error", this.#pumpError);
        }
        finally {
            this.#pumping = false;
        }
    }
    // Commit `batch` as the next chunk, retrying transient failures with
    // bounded backoff (#37; spec Uplink). A failed commit must not abandon
    // its sequence number: the host consumes in/ strictly in order, so a gap
    // wedges the uplink for the rest of the session — the observed CfT abort
    // ("AbortError: Aborted due to security policy") cost the whole bench,
    // not one message. Retrying the SAME seq is idempotent:
    //   - commit truly failed (common case): nothing became visible — the
    //     swap file was never renamed in; dir creation is create-or-open;
    //   - commit landed but still threw: identical bytes re-land under the
    //     same name (host re-reads torn snapshots, invariant 3/F11), or, if
    //     already consumed, the re-created chunk sits below the host's
    //     consumption point, inert until session cleanup (D6).
    async #commitChunk(batch) {
        const seq = this.#outSeq;
        // Lane choice (#4): forced modes bypass the health machinery (labs
        // measure raw lanes); auto prefers dirname while it earns its keep.
        let dirLane = this.uplink === "dirname" || (this.uplink === "auto" && batch.length <= DIR_CHUNK_MAX_BYTES && this.#dirLaneEligible());
        let fellBack = false;
        for (let attempt = 0;; attempt++) {
            try {
                if (dirLane) {
                    // payload rides the directory *name*; no content write, no close()
                    const name = dirChunkName(seq, batch);
                    const t0 = performance.now();
                    await op(`committing ${name.slice(0, 12)}…/`, () => this.#inDir.getDirectoryHandle(name, { create: true }));
                    this.stats.dirChunks++;
                    if (this.uplink === "auto")
                        this.#dirLaneSample(performance.now() - t0);
                }
                else {
                    await this.#writeFile(chunkName(seq), batch, this.#inDir);
                    this.stats.fileChunks++;
                    // The dir lane failed but the same bytes landed as a file: the
                    // failure was lane-specific (name limits, filesystem quirks) —
                    // strike it; enough strikes latch it off for the session (#4).
                    if (fellBack)
                        this.#dirLaneStrike();
                }
                this.#outSeq = seq + 1;
                return;
            }
            catch (e) {
                if (dirLane && this.uplink === "auto") {
                    // #4 failure fallback: re-land THIS batch as a file chunk (same
                    // seq — idempotent, see above) instead of burning retries on a
                    // lane that may be structurally broken. Whether it was transient
                    // is judged by the file attempt's outcome, not guessed here.
                    dirLane = false;
                    fellBack = true;
                    this.stats.laneFallbacks = (this.stats.laneFallbacks ?? 0) + 1;
                    this.#emit("note", `chunk ${seq} dirname commit failed (${errMsg(e)}) — falling back to a file chunk`);
                    continue; // the file lane is a different mechanism; no backoff owed
                }
                if (attempt >= COMMIT_RETRY_MS.length || this.#closed)
                    throw e;
                this.stats.commitRetries = (this.stats.commitRetries ?? 0) + 1;
                this.#emit("note", `chunk ${seq} commit failed (${errMsg(e)}) — retrying in ${COMMIT_RETRY_MS[attempt]}ms`);
                await new Promise((r) => setTimeout(r, COMMIT_RETRY_MS[attempt]));
            }
        }
    }
    // ---- dirname-lane health (#4; auto mode only)
    /** May this small batch ride the dirname lane? "slow" earns one real
     *  batch as a re-probe once per reprobe window (the periodic re-probe:
     *  no synthetic traffic, the next chunk is the experiment). */
    #dirLaneEligible() {
        if (this.#dirLane === "on")
            return true;
        if (this.#dirLane === "broken")
            return false;
        if (Date.now() - this.#dirLaneSince >= this.#dirLaneReprobeMs) {
            this.#dirLaneSince = Date.now(); // one probe per window, even if it fails
            return true;
        }
        return false;
    }
    #dirLaneStrike() {
        if (this.#dirLane === "broken")
            return;
        if (++this.#dirLaneStrikes >= DIR_LANE_BROKEN_STRIKES) {
            this.#dirLane = "broken";
            this.stats.dirLane = "broken";
            this.#emit("note", `dirname lane disabled for this session (${this.#dirLaneStrikes} commits failed where file chunks worked)`);
        }
    }
    #dirLaneSample(ms) {
        this.stats.dirCommitMs = ewma(this.stats.dirCommitMs, ms);
        this.stats.dirLane = this.#dirLane;
        // Hidden tabs get throttled through no fault of the lane (F16) — don't
        // judge it on junk timings. (Node embedders have no document: judged.)
        const vis = globalThis.document?.visibilityState;
        if (this.#dirLane === "broken" || vis === "hidden")
            return;
        const file = this.stats.fileCommitMs;
        // Slow = over the absolute floor AND no longer meaningfully beating
        // the file baseline. The second clause keeps a uniformly slow
        // filesystem (dir 50 ms, file 200 ms — the lane still wins) honest.
        const slow = ms > this.#dirLaneSlowMs && (file === undefined || ms > file * 0.75);
        if (this.#dirLane === "on") {
            this.#dirSlowStreak = slow ? this.#dirSlowStreak + 1 : 0;
            // A streak, not one sample: a single GC pause or scan hiccup must
            // not park the fast lane (F10's 2.8 ms vs F7's ~70 ms is the gap
            // being probed — the asymmetry closing shows up as EVERY commit
            // landing at the scan floor, not one outlier).
            if (this.#dirSlowStreak >= DIR_LANE_SLOW_STREAK) {
                this.#dirLane = "slow";
                this.stats.dirLane = "slow";
                this.#dirLaneSince = Date.now();
                this.#emit("note", `dirname lane slow (${this.#dirSlowStreak}× > ${this.#dirLaneSlowMs}ms, EWMA ${this.stats.dirCommitMs.toFixed(1)}ms) — preferring file chunks, will re-probe`);
            }
        }
        else if (!slow) {
            // The re-probe came back fast: restore, and let the EWMA restart
            // from this sample so stale slow readings don't linger in stats.
            this.#dirLane = "on";
            this.stats.dirLane = "on";
            this.stats.dirCommitMs = ms;
            this.#dirSlowStreak = 0;
            this.#emit("note", `dirname lane recovered (${ms.toFixed(1)}ms) — fast lane restored`);
        }
        else {
            this.#dirLaneSince = Date.now(); // still slow; next probe next window
        }
    }
    // ---------------- incoming (host -> client)
    async #startNotifier() {
        const wake = () => {
            this.stats.wakeups++;
            void this.#wake();
        };
        this.#wakeFn = wake;
        if (this.#mode === "observer" || this.#mode === "hybrid" || this.#mode === "adaptive") {
            // NOT awaited (F19): observe() can stall for tens of seconds without
            // rejecting, and awaiting it here used to gate init — `ready`, the
            // uplink, heartbeats — behind a notifier the protocol can live
            // without (D1/D7). Until it settles, polling carries the session
            // (adaptive's session-start hot poll below + the safety poll).
            this.#attachObserver(wake);
        }
        if (this.#mode === "poll" || this.#mode === "hybrid") {
            this.#pollTimer = setInterval(wake, this.pollMs);
        }
        if (this.#mode === "adaptive")
            this.#markActive(); // session start counts as activity
        if (this.safetyMs > 0)
            this.#safetyTimer = setInterval(wake, this.safetyMs);
        // Presence beacon (D17): a quiet uplink notification — #enqueue, not
        // send(), because a heartbeat must NOT re-arm the adaptive hot poll
        // (2 s of hot polling per beat would gut the idle economics, F18).
        // ~44 B framed → always the dirname fast lane. In a hidden tab this
        // interval clamps to 1/min (F16); the host's detach window absorbs it.
        if (this.heartbeatMs > 0) {
            this.#heartbeatTimer = setInterval(() => {
                try {
                    this.#enqueue(FrameType.RPC, new TextEncoder().encode(JSON.stringify(rpcNotification("heartbeat"))));
                }
                catch { } // a dead pump already surfaced via "error"
            }, this.heartbeatMs);
        }
    }
    /** Observer startup, concurrent with session traffic. Three outcomes:
     *  settle (adopt), reject (downgrade, D7/F9), or stall past
     *  observeSettleMs (downgrade, F19 — the straggler is disconnected if
     *  it ever settles; by then the poll owns wakes). */
    #attachObserver(wake) {
        let obs;
        try {
            obs = new FileSystemObserver(wake);
        }
        catch (e) {
            this.#observerFailed(wake, `FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)})`);
            return;
        }
        const started = obs.observe(this.#dir, { recursive: true });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            started.then(() => obs.disconnect()).catch(() => { });
            this.#observerFailed(wake, `FileSystemObserver.observe() did not settle within ${this.#observeSettleMs}ms (F19)`);
        }, this.#observeSettleMs);
        started.then(() => {
            clearTimeout(timer);
            if (settled)
                return;
            settled = true;
            if (this.#closed)
                return obs.disconnect();
            this.#observer = obs; // adopted; teardown owns disconnect from here
        }, (e) => {
            clearTimeout(timer);
            if (settled)
                return;
            settled = true;
            // An observer that won't start is a downgrade, not a failure (D7).
            // (Known trigger: directories under /tmp on macOS — F9.)
            this.#observerFailed(wake, `FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)})`);
        });
    }
    #observerFailed(wake, why) {
        if (this.#closed)
            return;
        this.#emit("note", `${why} — falling back to polling`);
        this.#mode = "poll";
        if (!this.#pollTimer)
            this.#pollTimer = setInterval(wake, this.pollMs);
    }
    // Adaptive mode: hot poll exists only while traffic is flowing. The
    // observer (300ms cadence) and safety poll cover the idle case; the first
    // event after idle re-arms the hot poll.
    #markActive() {
        this.#lastActivity = Date.now();
        if (this.#mode !== "adaptive" || this.#hotTimer || this.#closed)
            return;
        this.#hotTimer = setInterval(() => {
            if (Date.now() - this.#lastActivity > 2000) {
                clearInterval(this.#hotTimer);
                this.#hotTimer = null;
                return;
            }
            this.#wakeFn();
        }, this.pollMs);
    }
    async #wake() {
        if (this.#reading) {
            this.#readAgain = true;
            return;
        }
        this.#reading = true;
        try {
            do {
                this.#readAgain = false;
                await this.#drainOutLog();
                await this.#checkStatus();
            } while (this.#readAgain);
        }
        catch (e) {
            this.#emit("note", `reader hiccup (retrying): ${errMsg(e)}`);
        }
        finally {
            this.#reading = false;
        }
    }
    // The out stream is segmented (out.<gen>.log, rotated by the host at
    // ~8 MB, always on frame boundaries). out.sig maps the stream:
    // {gen, size, prevFinal, total}. We drain the current segment, hop to the
    // next when the previous one is fully consumed, and ack cumulative
    // consumption so the host can pause the pty (flow control) and delete
    // consumed segments.
    async #drainOutLog() {
        let sig;
        try {
            const fh = await this.#dir.getFileHandle("out.sig");
            sig = JSON.parse(await (await fh.getFile()).text());
        }
        catch {
            return; // host hasn't written yet, or sig mid-rename — next wake
        }
        if (sig.gen > this.#gen + 1) {
            // Fell more than a whole segment behind (shouldn't happen with flow
            // control) — resync at the current segment, noting the gap.
            this.#emit("note", `fell ${sig.gen - this.#gen} segments behind; skipping ahead (output lost)`);
            this.#gen = sig.gen;
            this.#offset = 0;
        }
        while (true) {
            await this.#drainSegment();
            const behind = this.#gen < sig.gen;
            if (behind && this.#offset >= sig.prevFinal) {
                this.#gen++;
                this.#offset = 0;
                continue; // previous segment fully consumed; move on and keep draining
            }
            break;
        }
        this.#maybeAck();
    }
    async #drainSegment() {
        let bytes;
        try {
            const fh = await this.#dir.getFileHandle(`out.${String(this.#gen).padStart(8, "0")}.log`);
            const file = await fh.getFile();
            if (file.size <= this.#offset)
                return;
            bytes = new Uint8Array(await file.slice(this.#offset).arrayBuffer());
        }
        catch {
            // spec/FINDINGS.md F11: a File snapshot goes stale (NotReadableError)
            // if the host appends between getFile() and the read — routine under
            // live output. Transient by construction: offset didn't advance, next
            // wake re-reads.
            this.stats.staleReads = (this.stats.staleReads ?? 0) + 1;
            return;
        }
        const { frames, consumed } = parseFrames(bytes);
        this.#offset += consumed; // partial tail frame stays for next wake
        this.#cumConsumed += consumed;
        this.stats.bytesIn += consumed;
        if (consumed > 0)
            this.#markActive(); // stream flowing → stay hot
        const t3 = now();
        for (const f of frames) {
            if (f.type === FrameType.RPC) {
                let msg = null;
                try {
                    msg = decodeJson(f.payload);
                }
                catch { }
                // Responses settle pending requests and stop here; anything else
                // (future host-initiated traffic) falls through to the frame event.
                if (msg && this.#rpc.handleMessage(msg, t3))
                    continue;
            }
            if (this.#hold) {
                // Attaching (D18): park live frames until grant + replay have run
                // (responses above still settle — the grant itself arrives here).
                this.#hold.push([f, t3]);
                continue;
            }
            this.#emit("frame", f, t3);
            if (f.type === FrameType.DATA)
                this.#emit("data", f.payload);
        }
    }
    // Ack at most every 250 ms (or every 256 KB under load). Acks ride the
    // dirname fast lane, so they cost ~3 ms, not ~70.
    #maybeAck() {
        if (this.#closed || this.#cumConsumed <= this.#lastAckTotal)
            return;
        const bytesSince = this.#cumConsumed - this.#lastAckTotal;
        if (bytesSince < 262144 && Date.now() - this.#lastAckAt < 250)
            return;
        this.#lastAckTotal = this.#cumConsumed;
        this.#lastAckAt = Date.now();
        try {
            this.notify("ack", { total: this.#cumConsumed });
        }
        catch { }
    }
    async #checkStatus() {
        try {
            const fh = await this.#dir.getFileHandle("status.json");
            const f = await fh.getFile();
            const status = JSON.parse(await f.text());
            if (JSON.stringify(status) !== JSON.stringify(this.#status)) {
                this.#status = status;
                this.#emit("status", status);
                // Supersede fence (D18) — held while our own attach is in flight
                // (#hold non-null): a previously-attached session's status.json
                // permanently names a writer, and the grant record lands there
                // before the grant response is readable, so a fresh attacher
                // (epoch still 0) would fence itself on a stale record — or on
                // its own grant. Found by the #58 cooperative loop: resumed
                // terminals were dead (sends silently poisoned) whenever the
                // session had been attached before. #completeAttach re-judges
                // once the granted epoch is in.
                if (this.#hold === null)
                    this.#maybeFence(status);
            }
        }
        catch { }
    }
    /** Fence this writer if `status` names a higher epoch (D18): stop
     *  writing — one writer per file is the law (F8/D6) — but keep reading:
     *  the downlink is multi-reader. */
    #maybeFence(status) {
        if (status.writer && status.writer.epoch > this.#epoch && !this.#pumpError) {
            this.#pumpError = new Error(`superseded: another client attached (writer epoch ${status.writer.epoch})`);
            clearInterval(this.#heartbeatTimer);
            this.#queue.length = 0; // never commit these — the lane is gone
            this.#emit("note", `superseded by writer epoch ${status.writer.epoch}: sends now fail, reads continue`);
        }
    }
    /** Resolve when status matches `pred`, reject after timeoutMs. */
    waitForStatus(pred, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            const check = (status) => {
                if (status && pred(status)) {
                    cleanup();
                    resolve(status);
                }
            };
            const off = this.on("status", check);
            const to = setTimeout(() => {
                cleanup();
                reject(new Error("status timeout"));
            }, timeoutMs);
            const cleanup = () => {
                off();
                clearTimeout(to);
            };
            check(this.#status);
        });
    }
    // ---------------- lifecycle
    // Cleanup is the HOST's job: it deletes the session dir after the close
    // notification. (Lesson learned: a client-side recursive delete races
    // with host writes — doorbell renames, status.json — and dies with
    // InvalidModificationError. Two processes must never contend for the same
    // files; cleanup has one owner, and it's the side with POSIX semantics.)
    async close() {
        if (this.#closed)
            return;
        clearInterval(this.#heartbeatTimer); // no beats into a closing session
        try {
            this.notify("close");
        }
        catch { }
        await this.#teardown();
    }
    /** Deliberate walk-away (D18): ask the host to mark the session detached
     *  NOW (no heartbeat-silence wait), then release local resources WITHOUT
     *  closing the session — the process keeps running for a later
     *  `attachSession()`. */
    async detach() {
        if (this.#closed)
            return;
        clearInterval(this.#heartbeatTimer);
        try {
            this.notify("detach");
        }
        catch { }
        await this.#teardown();
    }
    async #teardown() {
        // Wait for in-flight commits to flush (the close/detach notification
        // rides them) — except mid-attach, where no uplink lane exists yet and
        // the pump is parked on a grant that failAll() below will reject.
        if (this.#hold === null)
            while (this.#pumping)
                await new Promise((r) => setTimeout(r, 10));
        this.#closed = true;
        this.#rpc.failAll(new Error("session closed"));
        this.#observer?.disconnect();
        clearInterval(this.#pollTimer);
        if (this.#hotTimer)
            clearInterval(this.#hotTimer);
        clearInterval(this.#safetyTimer);
        this.#listeners.clear(); // disposal: nothing fires after close() (D11)
    }
}
//# sourceMappingURL=index.js.map