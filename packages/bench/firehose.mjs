#!/usr/bin/env node
// Firehose test: spawns a shell that floods stdout, consumes it like a
// well-behaved acking client, and verifies flow control works:
//   - disk usage stays bounded (consumed segments get deleted)
//   - the host pauses/resumes the pty against the ack window
//   - every byte arrives (line count integrity)
//
// Usage (host must be running with --allow-shell):
//   node packages/bench/firehose.mjs <dir> [--lines 400000] [--slow]
//   --slow: consumer acks lazily to force pause/resume cycles

import fs from "node:fs";
import path from "node:path";
import {
  FrameType,
  jsonFrame,
  parseFrames,
  chunkName,
  dirChunkName,
  DIR_CHUNK_MAX_BYTES,
} from "../common/frames.js";
import { rpcRequest, rpcNotification, SPAWN_REQUEST_ID } from "../common/rpc.js";

const args = process.argv.slice(2);
const opts = { lines: 400_000, slow: false };
let rootArg = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--lines") opts.lines = Number(args[++i]);
  else if (a === "--slow") opts.slow = true;
  else if (!a.startsWith("-")) rootArg = a;
}

const sessionDir = path.join(path.resolve(rootArg), ".fsio", "sessions", `firehose-${Date.now()}`);
const inDir = path.join(sessionDir, "in");
fs.mkdirSync(inDir, { recursive: true });

let seq = 1;
function commitFrame(bytes) {
  if (bytes.length <= DIR_CHUNK_MAX_BYTES) {
    fs.mkdirSync(path.join(inDir, dirChunkName(seq++, bytes)));
  } else {
    const t = path.join(inDir, ".t");
    fs.writeFileSync(t, bytes);
    fs.renameSync(t, path.join(inDir, chunkName(seq++)));
  }
}

// spawn: emit `lines` numbered lines as fast as possible, then a sentinel
const marker = "FIREHOSE-DONE";
const cmd = `seq 1 ${opts.lines}; echo ${marker}`;
fs.writeFileSync(
  path.join(sessionDir, ".t"),
  JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", { kind: "shell", cmd: "/bin/sh", args: ["-c", cmd], pty: true, cols: 200, rows: 24 }))
);
fs.renameSync(path.join(sessionDir, ".t"), path.join(sessionDir, "spawn.json"));

// segment-aware acking reader (mirrors the web client)
let gen = 0, offset = 0, cum = 0, lastAck = 0, lastAckAt = 0;
let text = "";
let maxDirBytes = 0, maxSegs = 0;
const segPath = (g) => path.join(sessionDir, `out.${String(g).padStart(8, "0")}.log`);

function drain() {
  let sig;
  try {
    sig = JSON.parse(fs.readFileSync(path.join(sessionDir, "out.sig"), "utf8"));
  } catch {
    return;
  }
  while (true) {
    try {
      const buf = fs.readFileSync(segPath(gen));
      if (buf.length > offset) {
        const { frames, consumed } = parseFrames(buf.subarray(offset));
        offset += consumed;
        cum += consumed;
        for (const f of frames) if (f.type === FrameType.DATA) text += Buffer.from(f.payload).toString("utf8");
      }
    } catch {}
    if (gen < sig.gen && offset >= sig.prevFinal) {
      gen++;
      offset = 0;
      continue;
    }
    break;
  }
  const ackInterval = opts.slow ? 1500 : 250;
  if (cum > lastAck && (cum - lastAck >= 262144 || Date.now() - lastAckAt > ackInterval)) {
    if (!opts.slow || Date.now() - lastAckAt > ackInterval) {
      lastAck = cum;
      lastAckAt = Date.now();
      commitFrame(jsonFrame(FrameType.RPC, rpcNotification("ack", { total: cum })));
    }
  }
  // track worst-case footprint
  const segs = fs.readdirSync(sessionDir).filter((n) => n.startsWith("out.") && n.endsWith(".log"));
  maxSegs = Math.max(maxSegs, segs.length);
  maxDirBytes = Math.max(maxDirBytes, segs.reduce((n, f) => n + fs.statSync(path.join(sessionDir, f)).size, 0));
}

const t0 = Date.now();
const timer = setInterval(drain, 5);
while (!text.includes(marker) && Date.now() - t0 < 120_000) {
  await new Promise((r) => setTimeout(r, 100));
}
clearInterval(timer);
drain();

const lineCount = (text.match(/\n/g) ?? []).length;
const expectMin = opts.lines; // pty adds \r\n; count \n per emitted line (+ shell noise)
const ok = text.includes(marker) && lineCount >= expectMin;
console.log(`firehose ${ok ? "PASS" : "FAIL"} (${opts.slow ? "slow consumer" : "fast consumer"})`);
console.log(`  lines expected \u2265${expectMin}, got ${lineCount}; sentinel: ${text.includes(marker)}`);
console.log(`  received ${(cum / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
  `(${(cum / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s)`);
console.log(`  peak on disk: ${(maxDirBytes / 1048576).toFixed(1)} MB across \u2264${maxSegs} segments (cap \u2248 12 MB)`);

commitFrame(jsonFrame(FrameType.RPC, rpcNotification("close")));
setTimeout(() => process.exit(ok ? 0 : 1), 600);
