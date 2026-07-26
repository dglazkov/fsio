// fsio browser client library (v0).
//
// Transport asymmetry (deliberate, see spec/DECISIONS.md D2):
//   host -> browser: append-only framed log (sessions/<id>/out.log); browser
//     reads from a byte offset on each wakeup.
//   browser -> host: numbered chunk files (sessions/<id>/in/NNNNNNNN.f);
//     FileSystemWritableFileStream commits atomically on close(). The host
//     consumes chunks in order and deletes them.

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

export { FrameType, jsonFrame, decodeJson, now, RpcError };
export type { Frame, HostInfo, SessionStatus, SpawnResult, SpawnSpec, PingResult };

export const hasObserver = "FileSystemObserver" in self;

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

export type NotifierMode = "auto" | "adaptive" | "hybrid" | "poll" | "observer";
export type UplinkMode = "auto" | "file" | "dirname";

export interface SessionOptions {
  mode?: NotifierMode;
  pollMs?: number;
  uplink?: UplinkMode;
  /** 0 disables the safety poll (measurement labs) */
  safetyMs?: number;
  onFrame?: ((frame: Frame, t3: number) => void) | null;
  onError?: ((e: Error) => void) | null;
  /** non-fatal observations, e.g. observer fallback */
  onNote?: ((note: string) => void) | null;
}

export class FsioClient {
  root: FileSystemDirectoryHandle;
  fsioDir!: FileSystemDirectoryHandle;
  sessionsDir!: FileSystemDirectoryHandle;

  constructor(rootHandle: FileSystemDirectoryHandle) {
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

  async createSession(spec: SpawnSpec, opts: SessionOptions = {}): Promise<FsioSession> {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dirHandle = await op(`creating session folder ${id}`, () =>
      this.sessionsDir.getDirectoryHandle(id, { create: true })
    );
    const session = new FsioSession(id, dirHandle, opts);
    await session._init(spec);
    return session;
  }
}

export class FsioSession {
  id: string;
  dir: FileSystemDirectoryHandle;
  inDir!: FileSystemDirectoryHandle;
  mode: NotifierMode;
  pollMs: number;
  uplink: UplinkMode;
  safetyMs: number;
  onFrame: ((frame: Frame, t3: number) => void) | null;
  onError: ((e: Error) => void) | null;
  onNote: ((note: string) => void) | null;
  onStatus: ((status: SessionStatus) => void) | null = null;
  status: SessionStatus | null = null;
  /** Resolves with the spawn result; rejects with RpcError on spawn failure. */
  ready!: Promise<SpawnResult>;

  gen = 0; // current out segment being read
  offset = 0; // consumed bytes within current segment
  cumConsumed = 0; // cumulative bytes consumed across segments
  lastAckTotal = 0;
  lastAckAt = 0;
  outSeq = 1; // next chunk number to write
  queue: Uint8Array[] = []; // encoded frames awaiting commit
  pumping = false;
  reading = false;
  readAgain = false;
  closed = false;
  pumpError: Error | null = null; // first async send failure; surfaced via onError + next send()
  stats: { chunksWritten: number; bytesIn: number; bytesOut: number; wakeups: number; staleReads?: number } = {
    chunksWritten: 0,
    bytesIn: 0,
    bytesOut: 0,
    wakeups: 0,
  };
  // Control plane: JSON-RPC over RPC frames (spec D10). One endpoint per
  // session owns id correlation; responses are consumed in _drainSegment.
  rpc: RpcEndpoint;

  private observer: FileSystemObserver | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private hotTimer: ReturnType<typeof setInterval> | null = null;
  private safetyTimer: ReturnType<typeof setInterval> | undefined;
  private lastActivity = 0;
  private _wakeFn!: () => void;

  constructor(id: string, dirHandle: FileSystemDirectoryHandle, opts: SessionOptions = {}) {
    const { mode = "auto", pollMs = 5, uplink = "auto", safetyMs = 500, onFrame = null, onError = null, onNote = null } = opts;
    this.safetyMs = safetyMs;
    this.onNote = onNote;
    // uplink "auto": small frame batches ride the dirname fast lane (≤80ms
    // → ~3ms measured, spec/FINDINGS.md F10 — directory creation skips
    // Chrome's after-write scan); big batches fall back to file chunks.
    // "file" forces file chunks.
    this.uplink = uplink;
    this.id = id;
    this.dir = dirHandle;
    // Notifier modes (spec/FINDINGS.md F6, refined by the observer lab):
    //   adaptive (default) — observer as idle sentinel (Chrome delivers on a
    //     ~300ms cadence: fine for waking up, useless for streams) + hot poll
    //     only while traffic flowed in the last 2s. Interactive latency of
    //     polling, idle cost of observers.
    //   hybrid — observer + always-on hot poll. poll — polling only.
    //   observer — observer only (for science).
    this.mode = mode === "auto" ? (hasObserver ? "adaptive" : "poll") : mode;
    this.pollMs = pollMs;
    this.onFrame = onFrame;
    this.onError = onError;
    this.rpc = new RpcEndpoint((msg) => this.sendJson(FrameType.RPC, msg));
  }

  async _init(spec: SpawnSpec): Promise<void> {
    this.inDir = await op(`creating session ${this.id}/in/`, () => this.dir.getDirectoryHandle("in", { create: true }));
    // spawn.json is written last: its appearance signals a complete session.
    // It carries a JSON-RPC spawn *request*; the host answers on the out
    // stream, so spawn failures arrive as real error objects (code,
    // message) instead of a status.json state to poll for. Register the
    // pending id before the file exists so the answer can't race us.
    this.ready = this.rpc.expect<SpawnResult>(SPAWN_REQUEST_ID).then(({ result }) => result);
    this.ready.catch(() => {}); // surfacing is the awaiter's job, not the console's
    await this._writeFile("spawn.json", new TextEncoder().encode(JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spec))));
    await this._startNotifier();
  }

  async _writeFile(name: string, bytes: Uint8Array, dir: FileSystemDirectoryHandle = this.dir): Promise<void> {
    return op(`committing ${name}`, async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes as Uint8Array<ArrayBuffer>);
      await w.close(); // atomic commit point
    });
  }

  // ---------------- outgoing (browser -> host)

  /** Enqueue a frame; frames queued while a commit is in flight are batched
   *  into a single chunk file. Commits are strictly serialized. */
  send(type: number, payload: Uint8Array): void {
    if (this.pumpError) throw this.pumpError;
    this.queue.push(encodeFrame(type, payload));
    this._markActive(); // user input → replies are coming; be ready for them
    this._pump();
  }

  sendJson(type: number, obj: unknown): void {
    this.send(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  sendData(text: string): void {
    this.send(FrameType.DATA, new TextEncoder().encode(text));
  }

  /** JSON-RPC request to the host; resolves {result, rx}. */
  request<R = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }) {
    return this.rpc.request<R>(method, params, opts);
  }

  /** JSON-RPC notification (fire-and-forget: resize, ack, close…). */
  notify(method: string, params?: unknown): void {
    this.rpc.notify(method, params);
  }

  async _pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const batch = concatBytes(this.queue.splice(0));
        if (this.uplink !== "file" && batch.length <= DIR_CHUNK_MAX_BYTES) {
          // payload rides the directory *name*; no content write, no close()
          const name = dirChunkName(this.outSeq++, batch);
          await op(`committing ${name.slice(0, 12)}…/`, () => this.inDir.getDirectoryHandle(name, { create: true }));
        } else {
          await this._writeFile(chunkName(this.outSeq++), batch, this.inDir);
        }
        this.stats.chunksWritten++;
        this.stats.bytesOut += batch.length;
      }
    } catch (e) {
      this.pumpError = e instanceof Error ? e : new Error(String(e));
      this.onError?.(this.pumpError);
    } finally {
      this.pumping = false;
    }
  }

  // ---------------- incoming (host -> browser)

  async _startNotifier(): Promise<void> {
    const wake = () => {
      this.stats.wakeups++;
      this._wake();
    };
    this._wakeFn = wake;
    if (this.mode === "observer" || this.mode === "hybrid" || this.mode === "adaptive") {
      try {
        this.observer = new FileSystemObserver(wake);
        await this.observer.observe(this.dir, { recursive: true });
      } catch (e) {
        // An observer that won't start is a downgrade, not a failure.
        // (Known trigger: directories under /tmp on macOS — spec/FINDINGS.md F9.)
        this.onNote?.(`FileSystemObserver refused to start (${errName(e)}: ${errMsg(e)}) — falling back to polling`);
        this.observer = null;
        this.mode = "poll";
      }
    }
    if (this.mode === "poll" || this.mode === "hybrid") {
      this.pollTimer = setInterval(wake, this.pollMs);
    }
    if (this.mode === "adaptive") this._markActive(); // session start counts as activity
    if (this.safetyMs > 0) this.safetyTimer = setInterval(wake, this.safetyMs);
  }

  // Adaptive mode: hot poll exists only while traffic is flowing. The
  // observer (300ms cadence) and safety poll cover the idle case; the first
  // event after idle re-arms the hot poll.
  _markActive(): void {
    this.lastActivity = Date.now();
    if (this.mode !== "adaptive" || this.hotTimer || this.closed) return;
    this.hotTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 2000) {
        clearInterval(this.hotTimer!);
        this.hotTimer = null;
        return;
      }
      this._wakeFn();
    }, this.pollMs);
  }

  async _wake(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        await this._drainOutLog();
        await this._checkStatus();
      } while (this.readAgain);
    } catch (e) {
      this.onNote?.(`reader hiccup (retrying): ${errMsg(e)}`);
    } finally {
      this.reading = false;
    }
  }

  // The out stream is segmented (out.<gen>.log, rotated by the host at
  // ~8 MB, always on frame boundaries). out.sig maps the stream:
  // {gen, size, prevFinal, total}. We drain the current segment, hop to the
  // next when the previous one is fully consumed, and ack cumulative
  // consumption so the host can pause the pty (flow control) and delete
  // consumed segments.
  async _drainOutLog(): Promise<void> {
    let sig: OutSig;
    try {
      const fh = await this.dir.getFileHandle("out.sig");
      sig = JSON.parse(await (await fh.getFile()).text()) as OutSig;
    } catch {
      return; // host hasn't written yet, or sig mid-rename — next wake
    }
    if (sig.gen > this.gen + 1) {
      // Fell more than a whole segment behind (shouldn't happen with flow
      // control) — resync at the current segment, noting the gap.
      this.onNote?.(`fell ${sig.gen - this.gen} segments behind; skipping ahead (output lost)`);
      this.gen = sig.gen;
      this.offset = 0;
    }
    while (true) {
      await this._drainSegment();
      const behind = this.gen < sig.gen;
      if (behind && this.offset >= sig.prevFinal) {
        this.gen++;
        this.offset = 0;
        continue; // previous segment fully consumed; move on and keep draining
      }
      break;
    }
    this._maybeAck();
  }

  async _drainSegment(): Promise<void> {
    let bytes: Uint8Array;
    try {
      const fh = await this.dir.getFileHandle(`out.${String(this.gen).padStart(8, "0")}.log`);
      const file = await fh.getFile();
      if (file.size <= this.offset) return;
      bytes = new Uint8Array(await file.slice(this.offset).arrayBuffer());
    } catch {
      // spec/FINDINGS.md F11: a File snapshot goes stale (NotReadableError)
      // if the host appends between getFile() and the read — routine under
      // live output. Transient by construction: offset didn't advance, next
      // wake re-reads.
      this.stats.staleReads = (this.stats.staleReads ?? 0) + 1;
      return;
    }
    const { frames, consumed } = parseFrames(bytes);
    this.offset += consumed; // partial tail frame stays for next wake
    this.cumConsumed += consumed;
    this.stats.bytesIn += consumed;
    if (consumed > 0) this._markActive(); // stream flowing → stay hot
    const t3 = now();
    for (const f of frames) {
      if (f.type === FrameType.RPC) {
        let msg: unknown = null;
        try {
          msg = decodeJson(f.payload);
        } catch {}
        // Responses settle pending requests and stop here; anything else
        // (future host-initiated traffic) falls through to onFrame.
        if (msg && this.rpc.handleMessage(msg, t3)) continue;
      }
      this.onFrame?.(f, t3);
    }
  }

  // Ack at most every 250 ms (or every 256 KB under load). Acks ride the
  // dirname fast lane, so they cost ~3 ms, not ~70.
  _maybeAck(): void {
    if (this.closed || this.cumConsumed <= this.lastAckTotal) return;
    const bytesSince = this.cumConsumed - this.lastAckTotal;
    if (bytesSince < 262144 && Date.now() - this.lastAckAt < 250) return;
    this.lastAckTotal = this.cumConsumed;
    this.lastAckAt = Date.now();
    try {
      this.notify("ack", { total: this.cumConsumed });
    } catch {}
  }

  async _checkStatus(): Promise<void> {
    try {
      const fh = await this.dir.getFileHandle("status.json");
      const f = await fh.getFile();
      const status = JSON.parse(await f.text()) as SessionStatus;
      if (JSON.stringify(status) !== JSON.stringify(this.status)) {
        this.status = status;
        this.onStatus?.(status);
      }
    } catch {}
  }

  /** Resolve when status.json matches `pred`, reject after timeoutMs. */
  waitForStatus(pred: (status: SessionStatus) => boolean, timeoutMs = 4000): Promise<SessionStatus> {
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        if (this.status && pred(this.status)) {
          cleanup();
          resolve(this.status);
        }
      }, 50);
      const to = setTimeout(() => {
        cleanup();
        reject(new Error("status timeout"));
      }, timeoutMs);
      const cleanup = () => {
        clearInterval(iv);
        clearTimeout(to);
      };
    });
  }

  // ---------------- lifecycle

  // Cleanup is the HOST's job: it deletes the session dir after the close
  // notification. (Lesson learned: a browser-side recursive delete races
  // with host writes — doorbell renames, status.json — and dies with
  // InvalidModificationError. Two processes must never contend for the same
  // files; cleanup has one owner, and it's the side with POSIX semantics.)
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.notify("close");
    } catch {}
    while (this.pumping) await new Promise((r) => setTimeout(r, 10));
    this.closed = true;
    this.rpc.failAll(new Error("session closed"));
    this.observer?.disconnect();
    clearInterval(this.pollTimer);
    if (this.hotTimer) clearInterval(this.hotTimer);
    clearInterval(this.safetyTimer);
  }
}
