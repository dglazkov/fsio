#!/usr/bin/env node
// Node-side fsio client: measures ping-pong latency over the .fsio transport
// without a browser. Isolates the pure filesystem + fs.watch cost so browser
// numbers can be compared against it.
//
// Usage (host must be running against the same <dir>):
//   node packages/bench/dist/node-client.js <dir> [--count 200] [--poll <ms>] [--payload 0] [--warmup 20]
//
//   --poll <ms>   use polling instead of fs.watch for pong detection
import fs from "node:fs";
import path from "node:path";
import { FrameType, jsonFrame, decodeJson, parseFrames, now, chunkName, dirChunkName, DIR_CHUNK_MAX_BYTES, RpcEndpoint, rpcRequest, SPAWN_REQUEST_ID, } from "@fsio/common";
const args = process.argv.slice(2);
const opts = { count: 200, poll: 0, payload: 0, warmup: 20, uplink: "file" };
let rootArg = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--count")
        opts.count = Number(args[++i]);
    else if (a === "--poll")
        opts.poll = Number(args[++i]);
    else if (a === "--payload")
        opts.payload = Number(args[++i]);
    else if (a === "--warmup")
        opts.warmup = Number(args[++i]);
    else if (a === "--uplink")
        opts.uplink = args[++i] ?? "file";
    else if (!a.startsWith("-"))
        rootArg = a;
}
if (!rootArg) {
    console.error("usage: node-client <dir> [--count n] [--poll ms] [--payload bytes] [--warmup n]");
    process.exit(1);
}
const sharedDir = path.resolve(rootArg);
const fsioDir = path.join(sharedDir, ".fsio");
const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sessionDir = path.join(fsioDir, "sessions", sessionId);
const inDir = path.join(sessionDir, "in");
const outLog = path.join(sessionDir, "out.00000000.log"); // bench never rotates a segment
// ---- host presence check
const hostJson = path.join(fsioDir, "host.json");
try {
    const age = Date.now() - fs.statSync(hostJson).mtimeMs;
    if (age > 6000)
        console.warn(`warning: host.json is ${(age / 1000).toFixed(1)}s old; host may be dead`);
}
catch {
    console.error(`no host.json in ${fsioDir} — start the host first:\n  npm run host -- ${rootArg}`);
    process.exit(1);
}
// ---- create session
fs.mkdirSync(inDir, { recursive: true });
const spawnSpec = { kind: "echo", client: "node-bench" };
const tmp = path.join(sessionDir, ".tmp-spawn");
fs.writeFileSync(tmp, JSON.stringify(rpcRequest(SPAWN_REQUEST_ID, "spawn", spawnSpec)));
fs.renameSync(tmp, path.join(sessionDir, "spawn.json"));
// ---- chunk writer (atomic: temp + rename)
let outSeq = 1;
function commitFrame(bytes) {
    if (opts.uplink === "dirname" && bytes.length <= DIR_CHUNK_MAX_BYTES) {
        fs.mkdirSync(path.join(inDir, dirChunkName(outSeq++, bytes)));
        return;
    }
    const name = chunkName(outSeq++);
    const t = path.join(inDir, `.tmp-${name}`);
    fs.writeFileSync(t, bytes);
    fs.renameSync(t, path.join(inDir, name));
}
// ---- out.log reader + rpc endpoint (id correlation lives in common/rpc.ts)
let offset = 0;
let outFd = null;
const rpc = new RpcEndpoint((msg) => commitFrame(jsonFrame(FrameType.RPC, msg)));
function drainOutLog() {
    let size;
    try {
        if (outFd === null)
            outFd = fs.openSync(outLog, "r");
        size = fs.fstatSync(outFd).size;
    }
    catch {
        return;
    }
    if (size <= offset)
        return;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(outFd, buf, 0, buf.length, offset);
    const { frames, consumed } = parseFrames(buf);
    offset += consumed;
    const t3 = now();
    for (const f of frames) {
        if (f.type === FrameType.RPC)
            rpc.handleMessage(decodeJson(f.payload), t3);
    }
}
let watcher = null;
if (opts.poll > 0) {
    setInterval(drainOutLog, opts.poll);
}
else {
    watcher = fs.watch(sessionDir, drainOutLog);
}
const safety = setInterval(drainOutLog, 250);
// ---- ping-pong loop
const filler = "x".repeat(opts.payload);
async function ping() {
    const params = { t0: now(), filler };
    const { result, rx } = await rpc.request("ping", params);
    return { ...result, t3: rx };
}
function stats(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean };
}
const fmt = (x) => x.toFixed(2).padStart(8);
const mode = (opts.poll > 0 ? `poll ${opts.poll}ms` : "fs.watch") + (opts.uplink === "dirname" ? " +dirname-up" : "");
console.log(`fsio node bench: session ${sessionId}`);
console.log(`  mode=${mode} count=${opts.count} warmup=${opts.warmup} payload=${opts.payload}B`);
const results = [];
for (let i = 0; i < opts.warmup + opts.count; i++) {
    const r = await ping();
    if (i >= opts.warmup) {
        results.push({
            rtt: r.t3 - r.t0, // full round trip
            up: r.t1 - r.t0, // client commit -> host read
            host: r.t2 - r.t1, // host processing
            down: r.t3 - r.t2, // host append -> client read
        });
    }
}
console.log(`\n  leg        min      p50      p95      max     mean  (ms)`);
for (const key of ["rtt", "up", "host", "down"]) {
    const s = stats(results.map((r) => r[key]));
    console.log(`  ${key.padEnd(5)}${fmt(s.min)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)} ${fmt(s.mean)}`);
}
// markdown row for the spec
const s = stats(results.map((r) => r.rtt));
console.log(`\n  | node client | ${mode} | ${opts.count} | ${opts.payload} | ${s.min.toFixed(2)} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.max.toFixed(2)} |`);
// ---- cleanup
rpc.notify("close");
setTimeout(() => {
    watcher?.close();
    clearInterval(safety);
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    catch { }
    process.exit(0);
}, 300);
//# sourceMappingURL=node-client.js.map