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

import {
  FrameType,
  encodeFrame,
  jsonFrame,
  decodeJson,
  parseFrames,
  concatBytes,
  now,
  chunkName,
  dirChunkName,
  DIR_CHUNK_MAX_BYTES,
  RpcEndpoint,
  RpcError,
  rpcRequest,
  SPAWN_REQUEST_ID,
  type Frame,
  type HostInfo,
  type OutSig,
  type SessionStatus,
  type SpawnResult,
  type SpawnSpec,
  type PingResult,
} from "@fsio/common";
import type { FsDirectory, FsFile, FsSnapshot, FsWritable } from "./fs.js";

export { FrameType, jsonFrame, decodeJson, now, RpcError };
export type { Frame, HostInfo, SessionStatus, SpawnResult, SpawnSpec, PingResult };
export type { FsDirectory, FsFile, FsSnapshot, FsWritable };

export const hasObserver = "FileSystemObserver" in globalThis;

const errName = (e: unknown) => (e instanceof DOMException || e instanceof Error ? e.name : "Error");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Wrap an FS operation so failures say WHAT we were doing, not just Chrome's
// terse DOMException ("The object can not be modified in this way").
export async function op<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = new Error(`${label}: ${errName(e)}: ${errMsg(e)}`);
    err.cause = e;
    throw err;
  }
}

/** Internal listener storage erases the per-event tuple types; on() restores them. */
// deliberate `any`: variance of the tuple-typed listeners is checked at on()
type Listener = (...args: any[]) => void;

export type NotifierMode = "auto" | "adaptive" | "hybrid" | "poll" | "observer";
export type UplinkMode = "auto" | "file" | "dirname";

export interface SessionOptions {
  mode?: NotifierMode;
  pollMs?: number;
  uplink?: UplinkMode;
  /** 0 disables the safety poll (measurement labs) */
  safetyMs?: number;
}

export interface SessionEventMap {
  /** Every delivered frame (including DATA). RPC responses are consumed by
   *  the control plane and do not appear here. */
  frame: [frame: Frame, at: number];
  /** Payload of each DATA frame — the one obvious way to consume output. */
  data: [bytes: Uint8Array];
  /** status.json changed (deep-compared). */
  status: [status: SessionStatus];
  /** Non-fatal observations, e.g. observer fallback to polling (D7). */
  note: [note: string];
  /** Async failures the library can't throw at you synchronously: uplink
   *  commit errors, throwing event listeners. With no error listener these
   *  are re-thrown on a fresh stack (uncaught, visible). */
  error: [error: Error];
}

export class FsioClient {
  readonly root: FsDirectory;
  fsioDir!: FsDirectory;
  sessionsDir!: FsDirectory;

  constructor(rootHandle: FsDirectory) {
    this.root = rootHandle;
  }

  async connect() {
    this.fsioDir = await op("opening .fsio/", () => this.root.getDirectoryHandle(".fsio", { create: true }));
    this.sessionsDir = await op("opening .fsio/sessions/", () => this.fsioDir.getDirectoryHandle("sessions", { create: true }));
    return this.hostInfo();
  }

  /** Reads host.json; returns {alive, info, ageMs} */
  async hostInfo(): Promise<{ alive: boolean; ageMs: number; info: HostInfo | null }> {
    try {
      const fh = await this.fsioDir.getFileHandle("host.json");
      const f = await fh.getFile();
      const info = JSON.parse(await f.text()) as HostInfo;
      const ageMs = Date.now() - f.lastModified;
      return { alive: ageMs < 6000, ageMs, info };
    } catch {
      return { alive: false, ageMs: Infinity, info: null };
    }
  }

  /** Synchronous by design (D11): the caller gets a listener-attachment
   *  window before any event can possibly fire. All async init failures
   *  (folder creation, spawn.json commit) reject `session.ready`. */
  createSession(spec: SpawnSpec, opts: SessionOptions = {}): FsioSession {
    if (!this.sessionsDir) throw new Error("createSession before connect()");
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new FsioSession(id, this.sessionsDir, spec, opts);
  }
}

export class FsioSession {
  readonly id: string;
  readonly pollMs: number;
  readonly uplink: UplinkMode;
  readonly safetyMs: number;
  /** Resolves with the spawn result; rejects with RpcError on spawn failure
   *  (and with the underlying error on init failure). */
  readonly ready: Promise<SpawnResult>;
  stats: {
    chunksWritten: number;
    /** chunks that rode the dirname fast lane vs. file chunks (#4: the
     *  auto lane's fallback dynamics are a measured quantity) */
    dirChunks: number;
    fileChunks: number;
    bytesIn: number;
    bytesOut: number;
    wakeups: number;
    staleReads?: number;
  } = {
    chunksWritten: 0,
    dirChunks: 0,
    fileChunks: 0,
    bytesIn: 0,
    bytesOut: 0,
    wakeups: 0,
  };

  /** Effective notifier mode; may downgrade at init (observer refusal, D7). */
  get mode(): NotifierMode {
    return this.#mode;
  }
  get status(): SessionStatus | null {
    return this.#status;
  }
  get closed(): boolean {
    return this.#closed;
  }

  #mode: NotifierMode;
  #status: SessionStatus | null = null;
  #dir!: FsDirectory;
  #inDir!: FsDirectory;
  #initDone: Promise<void>;
  #listeners = new Map<keyof SessionEventMap, Set<Listener>>();

  #gen = 0; // current out segment being read
  #offset = 0; // consumed bytes within current segment
  #cumConsumed = 0; // cumulative bytes consumed across segments
  #lastAckTotal = 0;
  #lastAckAt = 0;
  #outSeq = 1; // next chunk number to write
  #queue: Uint8Array[] = []; // encoded frames awaiting commit
  #pumping = false;
  #reading = false;
  #readAgain = false;
  #closed = false;
  #pumpError: Error | null = null; // first async send failure; surfaced via "error" + next send()
  // Control plane: JSON-RPC over RPC frames (spec D10). One endpoint per
  // session owns id correlation; responses are consumed in #drainSegment.
  #rpc: RpcEndpoint;

  #observer: FileSystemObserver | null = null;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #hotTimer: ReturnType<typeof setInterval> | null = null;
  #safetyTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivity = 0;
  #wakeFn!: () => void;

  constructor(id: string, sessionsDir: FsDirectory, spec: SpawnSpec, opts: SessionOptions = {}) {
    const { mode = "auto", pollMs = 5, uplink = "auto", safetyMs = 500 } = opts;
    this.id = id;
    this.pollMs = pollMs;
    this.safetyMs = safetyMs;
    // uplink "auto": small frame batches ride the dirname fast lane (≤80ms
    // → ~3ms measured, spec/FINDINGS.md F10 — directory creation skips
    // Chrome's after-write scan); big batches fall back to file chunks.
    // "file" forces file chunks.
    this.uplink = uplink;
    // Notifier modes (spec/FINDINGS.md F6, refined by the observer lab):
    //   adaptive (default) — observer as idle sentinel (Chrome delivers on a
    //     ~300ms cadence: fine for waking up, useless for streams) + hot poll
    //     only while traffic flowed in the last 2s. Interactive latency of
    //     polling, idle cost of observers.
    //   hybrid — observer + always-on hot poll. poll — polling only.
    //   observer — observer only (for science).
    this.#mode = mode === "auto" ? (hasObserver ? "adaptive" : "poll") : mode;
    this.#rpc = new RpcEndpoint((msg) => this.sendJson(FrameType.RPC, msg));
    // Register the pending spawn id before spawn.json exists so the host's
    // answer can't race us; park it until init has committed the request.
    const spawned = this.#rpc.expect<SpawnResult>(SPAWN_REQUEST_ID);
    spawned.catch(() => {}); // settled via `ready`; never an unhandled rejection
    this.#initDone = this.#init(sessionsDir, spec);
    this.ready = this.#initDone.then(() => spawned).then(({ result }) => result);
    this.ready.catch(() => {}); // surfacing is the awaiter's job, not the console's
  }

  /** Subscribe; returns the unsubscribe function (disposal, D11). All
   *  listeners are dropped on close(). */
  on<K extends keyof SessionEventMap>(type: K, listener: (...args: SessionEventMap[K]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  #emit<K extends keyof SessionEventMap>(type: K, ...args: SessionEventMap[K]): void {
    const set = this.#listeners.get(type);
    if (!set?.size) {
      // An unobserved transport failure must not vanish: rethrow on a fresh
      // stack so window.onerror / uncaughtException sees it.
      if (type === "error") setTimeout(() => { throw args[0]; }, 0);
      return;
    }
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        // A throwing listener must not lose frames or kill the drain loop
        // (D11): route to "error"; if *that* listener throws, fresh stack.
        const err = e instanceof Error ? e : new Error(String(e));
        if (type === "error") setTimeout(() => { throw err; }, 0);
        else this.#emit("error", err);
      }
    }
  }

  async #init(sessionsDir: FsDirectory, spec: SpawnSpec): Promise<void> {
    this.#dir = await op(`creating session folder ${this.id}`, () => sessionsDir.getDirectoryHandle(this.id, { create: true }));
    this.#inDir = await op(`creating session ${this.id}/in/`, () => this.#dir.getDirectoryHandle("in", { create: true }));
    // spawn.json is written last: its appearance signals a complete session.
    // It carries a JSON-RPC spawn *request*; the host answers on the out
    // stream, so spawn failures arrive as real error objects (code,
    // message) instead of a status.json state to poll for.
    await this.#writeFile("spawn.json", new TextEncoder().encode(JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec))));
    await this.#startNotifier();
  }

  async #writeFile(name: string, bytes: Uint8Array, dir: FsDirectory = this.#dir): Promise<void> {
    return op(`committing ${name}`, async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes as Uint8Array<ArrayBuffer>);
      await w.close(); // atomic commit point
    });
  }

  // ---------------- outgoing (client -> host)

  /** Enqueue a frame; frames queued while a commit is in flight are batched
   *  into a single chunk file. Commits are strictly serialized. */
  send(type: number, payload: Uint8Array): void {
    if (this.#pumpError) throw this.#pumpError;
    this.#queue.push(encodeFrame(type, payload));
    this.#markActive(); // user input → replies are coming; be ready for them
    void this.#pump();
  }

  sendJson(type: number, obj: unknown): void {
    this.send(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  sendData(text: string): void {
    this.send(FrameType.DATA, new TextEncoder().encode(text));
  }

  /** JSON-RPC request to the host; resolves {result, rx}. */
  request<R = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }) {
    return this.#rpc.request<R>(method, params, opts);
  }

  /** JSON-RPC notification (fire-and-forget: resize, ack, close…). */
  notify(method: string, params?: unknown): void {
    this.#rpc.notify(method, params);
  }

  /** Uncommitted uplink chunks in in/ (labs; #4 backlog dynamics). */
  async uplinkBacklog(): Promise<number> {
    await this.#initDone;
    let n = 0;
    for await (const _ of this.#inDir.keys()) n++;
    return n;
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      await this.#initDone; // sends may be queued while init is in flight
      while (this.#queue.length > 0 && !this.#closed) {
        const batch = concatBytes(this.#queue.splice(0));
        if (this.uplink !== "file" && batch.length <= DIR_CHUNK_MAX_BYTES) {
          // payload rides the directory *name*; no content write, no close()
          const name = dirChunkName(this.#outSeq++, batch);
          await op(`committing ${name.slice(0, 12)}…/`, () => this.#inDir.getDirectoryHandle(name, { create: true }));
          this.stats.dirChunks++;
        } else {
          await this.#writeFile(chunkName(this.#outSeq++), batch, this.#inDir);
          this.stats.fileChunks++;
        }
        this.stats.chunksWritten++;
        this.stats.bytesOut += batch.length;
      }
    } catch (e) {
      this.#pumpError = e instanceof Error ? e : new Error(String(e));
      this.#emit("error", this.#pumpError);
    } finally {
      this.#pumping = false;
    }
  }

  // ---------------- incoming (host -> client)

  async #startNotifier(): Promise<void> {
    const wake = () => {
      this.stats.wakeups++;
      void this.#wake();
    };
    this.#wakeFn = wake;
    if (this.#mode === "observer" || this.#mode === "hybrid" || this.#mode === "adaptive") {
      try {
        this.#observer = new FileSystemObserver(wake);
        await this.#observer.observe(this.#dir, { recursive: true });
      } catch (e) {
        // An observer that won't start is a downgrade, not a failure (D7).
        // (Known trigger: directories under /tmp on macOS — spec/FINDINGS.md F9.)
        this.#emit("note", `FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)}) — falling back to polling`);
        this.#observer = null;
        this.#mode = "poll";
      }
    }
    if (this.#mode === "poll" || this.#mode === "hybrid") {
      this.#pollTimer = setInterval(wake, this.pollMs);
    }
    if (this.#mode === "adaptive") this.#markActive(); // session start counts as activity
    if (this.safetyMs > 0) this.#safetyTimer = setInterval(wake, this.safetyMs);
  }

  // Adaptive mode: hot poll exists only while traffic is flowing. The
  // observer (300ms cadence) and safety poll cover the idle case; the first
  // event after idle re-arms the hot poll.
  #markActive(): void {
    this.#lastActivity = Date.now();
    if (this.#mode !== "adaptive" || this.#hotTimer || this.#closed) return;
    this.#hotTimer = setInterval(() => {
      if (Date.now() - this.#lastActivity > 2000) {
        clearInterval(this.#hotTimer!);
        this.#hotTimer = null;
        return;
      }
      this.#wakeFn();
    }, this.pollMs);
  }

  async #wake(): Promise<void> {
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
    } catch (e) {
      this.#emit("note", `reader hiccup (retrying): ${errMsg(e)}`);
    } finally {
      this.#reading = false;
    }
  }

  // The out stream is segmented (out.<gen>.log, rotated by the host at
  // ~8 MB, always on frame boundaries). out.sig maps the stream:
  // {gen, size, prevFinal, total}. We drain the current segment, hop to the
  // next when the previous one is fully consumed, and ack cumulative
  // consumption so the host can pause the pty (flow control) and delete
  // consumed segments.
  async #drainOutLog(): Promise<void> {
    let sig: OutSig;
    try {
      const fh = await this.#dir.getFileHandle("out.sig");
      sig = JSON.parse(await (await fh.getFile()).text()) as OutSig;
    } catch {
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

  async #drainSegment(): Promise<void> {
    let bytes: Uint8Array;
    try {
      const fh = await this.#dir.getFileHandle(`out.${String(this.#gen).padStart(8, "0")}.log`);
      const file = await fh.getFile();
      if (file.size <= this.#offset) return;
      bytes = new Uint8Array(await file.slice(this.#offset).arrayBuffer());
    } catch {
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
    if (consumed > 0) this.#markActive(); // stream flowing → stay hot
    const t3 = now();
    for (const f of frames) {
      if (f.type === FrameType.RPC) {
        let msg: unknown = null;
        try {
          msg = decodeJson(f.payload);
        } catch {}
        // Responses settle pending requests and stop here; anything else
        // (future host-initiated traffic) falls through to the frame event.
        if (msg && this.#rpc.handleMessage(msg, t3)) continue;
      }
      this.#emit("frame", f, t3);
      if (f.type === FrameType.DATA) this.#emit("data", f.payload);
    }
  }

  // Ack at most every 250 ms (or every 256 KB under load). Acks ride the
  // dirname fast lane, so they cost ~3 ms, not ~70.
  #maybeAck(): void {
    if (this.#closed || this.#cumConsumed <= this.#lastAckTotal) return;
    const bytesSince = this.#cumConsumed - this.#lastAckTotal;
    if (bytesSince < 262144 && Date.now() - this.#lastAckAt < 250) return;
    this.#lastAckTotal = this.#cumConsumed;
    this.#lastAckAt = Date.now();
    try {
      this.notify("ack", { total: this.#cumConsumed });
    } catch {}
  }

  async #checkStatus(): Promise<void> {
    try {
      const fh = await this.#dir.getFileHandle("status.json");
      const f = await fh.getFile();
      const status = JSON.parse(await f.text()) as SessionStatus;
      if (JSON.stringify(status) !== JSON.stringify(this.#status)) {
        this.#status = status;
        this.#emit("status", status);
      }
    } catch {}
  }

  /** Resolve when status matches `pred`, reject after timeoutMs. */
  waitForStatus(pred: (status: SessionStatus) => boolean, timeoutMs = 4000): Promise<SessionStatus> {
    return new Promise((resolve, reject) => {
      const check = (status: SessionStatus | null) => {
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
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      this.notify("close");
    } catch {}
    while (this.#pumping) await new Promise((r) => setTimeout(r, 10));
    this.#closed = true;
    this.#rpc.failAll(new Error("session closed"));
    this.#observer?.disconnect();
    clearInterval(this.#pollTimer);
    if (this.#hotTimer) clearInterval(this.#hotTimer);
    clearInterval(this.#safetyTimer);
    this.#listeners.clear(); // disposal: nothing fires after close() (D11)
  }
}
