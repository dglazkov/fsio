// fsio v0 frame encoding. Shared between Node host and browser client.
//
// Frame = [u32le payloadLength][u8 type][payload]
// A stream (out.log) or a chunk file (in/NNNNNNNN.f) is a concatenation of
// frames. A trailing partial frame means "not fully written yet" — readers
// MUST wait, never skip.

export const HEADER_SIZE = 5;

export const FrameType = {
  DATA: 1, // raw stdio/pty bytes
  PING: 2, // latency probe, JSON payload {seq, t0}
  PONG: 3, // echo of PING, JSON payload {seq, t0, t1, t2}
  CTL: 4, // control message, JSON payload {op, ...}
};

const frameTypeNames = Object.fromEntries(
  Object.entries(FrameType).map(([k, v]) => [v, k])
);

export function frameTypeName(type) {
  return frameTypeNames[type] ?? `0x${type.toString(16)}`;
}

export function encodeFrame(type, payload) {
  const buf = new Uint8Array(HEADER_SIZE + payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, payload.length, true);
  buf[4] = type;
  buf.set(payload, HEADER_SIZE);
  return buf;
}

export function jsonFrame(type, obj) {
  return encodeFrame(type, new TextEncoder().encode(JSON.stringify(obj)));
}

export function decodeJson(payload) {
  return JSON.parse(new TextDecoder().decode(payload));
}

// Parse as many complete frames as possible from `bytes`.
// Returns { frames: [{type, payload}], consumed: byteCount }.
// `consumed` stops before any trailing partial frame.
export function parseFrames(bytes) {
  const frames = [];
  let off = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + HEADER_SIZE <= bytes.length) {
    const len = dv.getUint32(off, true);
    if (off + HEADER_SIZE + len > bytes.length) break; // partial tail
    frames.push({
      type: bytes[off + 4],
      payload: bytes.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len),
    });
    off += HEADER_SIZE + len;
  }
  return { frames, consumed: off };
}

export function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// Cross-process comparable timestamp in ms (epoch-based, sub-ms precision).
export function now() {
  return performance.timeOrigin + performance.now();
}

export function chunkName(seq) {
  return String(seq).padStart(8, "0") + ".f";
}

export const CHUNK_RE = /^(\d{8})\.f$/;

// Dirname uplink (experimental, see spec open question 8): small frame
// batches encoded into a created directory's *name* — no file content, so
// (hypothesis) no browser after-write checks. Same sequence space as file
// chunks; consumers process both in seq order.
export const DIR_CHUNK_RE = /^(\d{8})-([A-Za-z0-9_-]+)$/;

export function dirChunkName(seq, bytes) {
  return String(seq).padStart(8, "0") + "-" + b64urlEncode(bytes);
}

export function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Max encoded name payload: most filesystems cap names at 255 bytes;
// 8 (seq) + 1 (dash) + ceil(4n/3) ≤ 255 → n ≤ ~180 raw bytes.
export const DIR_CHUNK_MAX_BYTES = 180;
