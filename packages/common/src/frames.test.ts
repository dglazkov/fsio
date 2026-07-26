// Unit tests: frame codec + name encodings.
// Enforces spec/PROTOCOL.md "Framing" and design invariant 3 (torn state:
// a trailing partial frame means "in progress" — wait, never skip).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_SIZE,
  FrameType,
  frameTypeName,
  encodeFrame,
  jsonFrame,
  decodeJson,
  parseFrames,
  concatBytes,
  chunkName,
  CHUNK_RE,
  dirChunkName,
  DIR_CHUNK_RE,
  b64urlEncode,
  b64urlDecode,
  DIR_CHUNK_MAX_BYTES,
} from "./frames.js";

const bytes = (...b: number[]) => new Uint8Array(b);

test("encodeFrame lays out [u32le length][u8 type][payload]", () => {
  const f = encodeFrame(FrameType.DATA, bytes(0xaa, 0xbb));
  assert.equal(f.length, HEADER_SIZE + 2);
  assert.deepEqual([...f], [2, 0, 0, 0, FrameType.DATA, 0xaa, 0xbb]);
});

test("roundtrip: multiple frames concatenated parse in order", () => {
  const a = encodeFrame(FrameType.DATA, bytes(1, 2, 3));
  const b = jsonFrame(FrameType.RPC, { hello: "world" });
  const c = encodeFrame(FrameType.DATA, bytes()); // zero-length payload is legal
  const { frames, consumed } = parseFrames(concatBytes([a, b, c]));
  assert.equal(frames.length, 3);
  assert.equal(consumed, a.length + b.length + c.length);
  assert.deepEqual([...frames[0]!.payload], [1, 2, 3]);
  assert.deepEqual(decodeJson(frames[1]!.payload), { hello: "world" });
  assert.equal(frames[2]!.payload.length, 0);
});

test("torn tail: parse stops before a partial frame and consumes nothing of it", () => {
  const whole = encodeFrame(FrameType.DATA, bytes(9, 9));
  const torn = encodeFrame(FrameType.DATA, new Uint8Array(100)).subarray(0, 40); // header promises 100
  const { frames, consumed } = parseFrames(concatBytes([whole, torn]));
  assert.equal(frames.length, 1);
  assert.equal(consumed, whole.length); // reader waits, never skips (invariant 3)
});

test("torn header: fewer than HEADER_SIZE bytes consumes nothing", () => {
  for (const n of [0, 1, HEADER_SIZE - 1]) {
    const { frames, consumed } = parseFrames(new Uint8Array(n));
    assert.equal(frames.length, 0);
    assert.equal(consumed, 0);
  }
});

test("parseFrames respects subarray offsets (reads from byteOffset)", () => {
  const frame = encodeFrame(FrameType.DATA, bytes(7));
  const shifted = concatBytes([bytes(0xff, 0xff), frame]).subarray(2);
  const { frames } = parseFrames(shifted);
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.payload], [7]);
});

test("frameTypeName names known types and hexes unknown ones", () => {
  assert.equal(frameTypeName(FrameType.DATA), "DATA");
  assert.equal(frameTypeName(FrameType.RPC), "RPC");
  assert.equal(frameTypeName(0x2a), "0x2a"); // forward-compat: unknown ≠ crash
});

test("b64url roundtrips all byte values with a url/filename-safe alphabet", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  const enc = b64urlEncode(all);
  assert.match(enc, /^[A-Za-z0-9_-]+$/); // no +, /, or = — must survive as a dirname
  assert.deepEqual([...b64urlDecode(enc)], [...all]);
});

test("chunk names: fixed-width seq, one shared sequence space across lanes", () => {
  assert.equal(chunkName(7), "00000007.f");
  assert.match(chunkName(7), CHUNK_RE);
  const dir = dirChunkName(7, bytes(1, 2, 3));
  const m = DIR_CHUNK_RE.exec(dir);
  assert.ok(m);
  assert.equal(Number(m[1]), 7); // same seq parse as file chunks
  assert.deepEqual([...b64urlDecode(m[2]!)], [1, 2, 3]);
});

test("fuzz: parseFrames never throws or over-consumes on corrupt/truncated input", () => {
  // Issue #1: a torn log must never crash or desync a reader. Deterministic
  // PRNG so failures reproduce.
  let seed = 0xf510;
  const rnd = (n: number) => (seed = (seed * 48271) % 0x7fffffff) % n;
  for (let iter = 0; iter < 2000; iter++) {
    // half pure noise, half a valid stream truncated at a random point
    let buf: Uint8Array;
    if (iter % 2 === 0) {
      buf = new Uint8Array(rnd(64)).map(() => rnd(256));
    } else {
      const frames: Uint8Array[] = [];
      for (let i = 0, n = rnd(4) + 1; i < n; i++) {
        frames.push(encodeFrame(rnd(256), new Uint8Array(rnd(32)).map(() => rnd(256))));
      }
      const whole = concatBytes(frames);
      buf = whole.subarray(0, rnd(whole.length + 1));
    }
    const { frames, consumed } = parseFrames(buf); // must not throw
    assert.ok(consumed <= buf.length, "consumed past the buffer");
    // prefix property: re-parsing the consumed prefix yields the same frames
    const again = parseFrames(buf.subarray(0, consumed));
    assert.equal(again.consumed, consumed, "consumed prefix is not stable");
    assert.equal(again.frames.length, frames.length);
  }
});

test("DIR_CHUNK_MAX_BYTES stays within the 255-byte filename budget", () => {
  // spec "Uplink": 8 (seq) + 1 (dash) + ceil(4n/3) ≤ 255 (F10 lane contract)
  const name = dirChunkName(99999999, new Uint8Array(DIR_CHUNK_MAX_BYTES).fill(0xff));
  assert.ok(name.length <= 255, `dirname chunk name is ${name.length} bytes`);
});
