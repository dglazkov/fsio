// fsio v0 frame encoding. Shared between Node host and browser client.
//
// Frame = [u32le payloadLength][u8 type][payload]
// A stream (out.log) or a chunk file (in/NNNNNNNN.f) is a concatenation of
// frames. A trailing partial frame means "not fully written yet" — readers
// MUST wait, never skip.
export const HEADER_SIZE = 5;
export const FrameType = {
    DATA: 1, // raw stdio/pty bytes
    // 2–4 reserved: early-v0 PING/PONG/CTL, retired when the control plane
    // moved to JSON-RPC (spec/DECISIONS.md D10). Never reuse.
    RPC: 5, // one JSON-RPC 2.0 message (rpc.ts)
};
const frameTypeNames = new Map(Object.entries(FrameType).map(([k, v]) => [v, k]));
export function frameTypeName(type) {
    return frameTypeNames.get(type) ?? `0x${type.toString(16)}`;
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
/** Parse as many complete frames as possible from `bytes`.
 *  `consumed` stops before any trailing partial frame. */
export function parseFrames(bytes) {
    const frames = [];
    let off = 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (off + HEADER_SIZE <= bytes.length) {
        const len = dv.getUint32(off, true);
        if (off + HEADER_SIZE + len > bytes.length)
            break; // partial tail
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
/** Cross-process comparable timestamp in ms (epoch-based, sub-ms precision). */
export function now() {
    return performance.timeOrigin + performance.now();
}
export function chunkName(seq) {
    return String(seq).padStart(8, "0") + ".f";
}
export const CHUNK_RE = /^(\d{8})\.f$/;
/** One out-log segment's file name (D9). Both sides build it: the host to
 *  append, a reader to find the segments a session left behind. */
export function segName(gen) {
    return `out.${String(gen).padStart(8, "0")}.log`;
}
export const OUT_LOG_RE = /^out\.(\d{8})\.log$/;
// Dirname uplink (F10): small frame batches encoded into a created
// directory's *name* — no file content, so no browser after-write checks.
// Same sequence space as file chunks; consumers process both in seq order.
//
// Case-folding audit (#4): b64url is case-sensitive, and common desktop
// filesystems (APFS, NTFS, exFAT) are case-INSENSITIVE. Safe anyway: any
// two distinct chunk names differ in the decimal seq prefix — a collision
// needs equal seq, and equal seq only happens on a same-chunk retry, whose
// name is byte-identical (create-or-open, spec Uplink). Those filesystems
// are case-PRESERVING, so the consumer reads back the exact name written.
// Case-DESTROYING filesystems (bare FAT16) would corrupt the payload and
// are out of scope; the client's failure/probe fallback (#4) is the net.
export const DIR_CHUNK_RE = /^(\d{8})-([A-Za-z0-9_-]+)$/;
export function dirChunkName(seq, bytes) {
    return String(seq).padStart(8, "0") + "-" + b64urlEncode(bytes);
}
export function b64urlEncode(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
    const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
// Max encoded name payload: most filesystems cap names at 255 bytes;
// 8 (seq) + 1 (dash) + ceil(4n/3) ≤ 255 → n ≤ ~180 raw bytes.
export const DIR_CHUNK_MAX_BYTES = 180;
//# sourceMappingURL=frames.js.map