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
} from "../common/frames.js";

export { FrameType, jsonFrame, decodeJson, now };

export const hasObserver = "FileSystemObserver" in self;

// Wrap an FS operation so failures say WHAT we were doing, not just Chrome's
// terse DOMException ("The object can not be modified in this way").
export async function op(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const err = new Error(`${label}: ${e.name ?? "Error"}: ${e.message}`);
    err.cause = e;
    throw err;
  }
}

export class FsioClient {
  /** @param {FileSystemDirectoryHandle} rootHandle user-picked directory */
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
    } catch {
      return { alive: false, ageMs: Infinity, info: null };
    }
  }

  /** @param {object} spec spawn spec, e.g. {kind:"echo"} or {kind:"shell",cols,rows} */
  async createSession(spec, opts = {}) {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dirHandle = await op(`creating session folder ${id}`, () =>
      this.sessionsDir.getDirectoryHandle(id, { create: true })
    );
    const session = new FsioSession(id, dirHandle, opts);
    session.parentDir = this.sessionsDir;
    await session._init(spec);
    return session;
  }
}

export class FsioSession {
  constructor(id, dirHandle, { mode = "auto", pollMs = 5, uplink = "auto", safetyMs = 500, onFrame = null, onError = null, onNote = null } = {}) {
    this.safetyMs = safetyMs; // 0 disables the safety poll (measurement labs)
    this.onNote = onNote; // non-fatal observations, e.g. observer fallback
    // uplink "auto": small frame batches ride the dirname fast lane (≤80ms
    // → ~3ms measured, spec/FINDINGS.md F10 — directory creation skips Chrome's
    // after-write scan); big batches fall back to file chunks. "file"
    // forces file chunks.
    this.uplink = uplink; // "file" | "dirname" (see spec/FINDINGS.md F10)
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
    this.onStatus = null;
    this.status = null;
    this.gen = 0; // current out segment being read
    this.offset = 0; // consumed bytes within current segment
    this.cumConsumed = 0; // cumulative bytes consumed across segments
    this.lastAckTotal = 0;
    this.lastAckAt = 0;
    this.outSeq = 1; // next chunk number to write
    this.queue = []; // encoded frames awaiting commit
    this.pumping = false;
    this.reading = false;
    this.readAgain = false;
    this.closed = false;
    this.pumpError = null; // first async send failure; surfaced via onError + next send()
    this.onError = onError;
    this.stats = { chunksWritten: 0, bytesIn: 0, bytesOut: 0, wakeups: 0 };
  }

  async _init(spec) {
    this.inDir = await op(`creating session ${this.id}/in/`, () => this.dir.getDirectoryHandle("in", { create: true }));
    // spawn.json is written last: its appearance signals a complete session.
    await this._writeFile("spawn.json", new TextEncoder().encode(JSON.stringify(spec)));
    await this._startNotifier();
  }

  async _writeFile(name, bytes, dir = this.dir) {
    return op(`committing ${name}`, async () => {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close(); // atomic commit point
    });
  }

  // ---------------- outgoing (browser -> host)

  /** Enqueue a frame; frames queued while a commit is in flight are batched
   *  into a single chunk file. Commits are strictly serialized. */
  send(type, payload) {
    if (this.pumpError) throw this.pumpError;
    this.queue.push(encodeFrame(type, payload));
    this._markActive(); // user input → replies are coming; be ready for them
    this._pump();
  }

  sendJson(type, obj) {
    return this.send(type, new TextEncoder().encode(JSON.stringify(obj)));
  }

  sendData(text) {
    return this.send(FrameType.DATA, new TextEncoder().encode(text));
  }

  async _pump() {
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
      this.pumpError = e;
      this.onError?.(e);
    } finally {
      this.pumping = false;
    }
  }

  // ---------------- incoming (host -> browser)

  async _startNotifier() {
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
        this.onNote?.(`FileSystemObserver refused to start (${e.name}: ${e.message}) — falling back to polling`);
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
  _markActive() {
    this.lastActivity = Date.now();
    if (this.mode !== "adaptive" || this.hotTimer || this.closed) return;
    this.hotTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 2000) {
        clearInterval(this.hotTimer);
        this.hotTimer = null;
        return;
      }
      this._wakeFn();
    }, this.pollMs);
  }

  async _wake() {
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
      this.onNote?.(`reader hiccup (retrying): ${e.message}`);
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
  async _drainOutLog() {
    let sig;
    try {
      const fh = await this.dir.getFileHandle("out.sig");
      sig = JSON.parse(await (await fh.getFile()).text());
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

  async _drainSegment() {
    let bytes;
    try {
      const fh = await this.dir.getFileHandle(`out.${String(this.gen).padStart(8, "0")}.log`);
      const file = await fh.getFile();
      if (file.size <= this.offset) return;
      bytes = new Uint8Array(await file.slice(this.offset).arrayBuffer());
    } catch (e) {
      // spec/FINDINGS.md F11: a File snapshot goes stale (NotReadableError) if the host
      // appends between getFile() and the read — routine under live output.
      // Transient by construction: offset didn't advance, next wake re-reads.
      this.stats.staleReads = (this.stats.staleReads ?? 0) + 1;
      return;
    }
    const { frames, consumed } = parseFrames(bytes);
    this.offset += consumed; // partial tail frame stays for next wake
    this.cumConsumed += consumed;
    this.stats.bytesIn += consumed;
    if (consumed > 0) this._markActive(); // stream flowing → stay hot
    const t3 = now();
    for (const f of frames) this.onFrame?.(f, t3);
  }

  // Ack at most every 250 ms (or every 256 KB under load). Acks ride the
  // dirname fast lane, so they cost ~3 ms, not ~70.
  _maybeAck() {
    if (this.closed || this.cumConsumed <= this.lastAckTotal) return;
    const bytesSince = this.cumConsumed - this.lastAckTotal;
    if (bytesSince < 262144 && Date.now() - this.lastAckAt < 250) return;
    this.lastAckTotal = this.cumConsumed;
    this.lastAckAt = Date.now();
    try {
      this.sendJson(FrameType.CTL, { op: "ack", total: this.cumConsumed });
    } catch {}
  }

  async _checkStatus() {
    try {
      const fh = await this.dir.getFileHandle("status.json");
      const f = await fh.getFile();
      const status = JSON.parse(await f.text());
      if (JSON.stringify(status) !== JSON.stringify(this.status)) {
        this.status = status;
        this.onStatus?.(status);
      }
    } catch {}
  }

  /** Resolve when status.json matches `pred`, reject after timeoutMs. */
  waitForStatus(pred, timeoutMs = 4000) {
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

  // Cleanup is the HOST's job: it deletes the session dir after CTL close.
  // (Lesson learned: a browser-side recursive delete races with host writes
  // — doorbell renames, status.json — and dies with InvalidModificationError.
  // Two processes must never contend for the same files; cleanup has one
  // owner, and it's the side with POSIX semantics.)
  async close() {
    if (this.closed) return;
    try {
      this.sendJson(FrameType.CTL, { op: "close" });
    } catch {}
    while (this.pumping) await new Promise((r) => setTimeout(r, 10));
    this.closed = true;
    this.observer?.disconnect();
    clearInterval(this.pollTimer);
    clearInterval(this.hotTimer);
    clearInterval(this.safetyTimer);
  }
}
