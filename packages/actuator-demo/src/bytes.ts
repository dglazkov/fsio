// Bytes, as a string, for the one operation that carries a file.
//
// `fling` puts a file's contents on the wire, and the wire is one JSON
// object per DATA frame (messages.ts) — so the bytes ride as base64 and
// pay 33%. The alternative, a binary frame beside a JSON header, would buy
// that back and cost the invariant that makes the framing readable: every
// frame in this demo is one self-describing object. A file this demo will
// carry is capped at MAX_FLING_BYTES, so the tax is bounded and small.
//
// btoa/atob are on both sides (Node ≥ 16 and every browser), so this is one
// implementation rather than two. The chunking is not decoration:
// `String.fromCharCode(...arr)` on a megabyte overflows the argument list.

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// The `<ArrayBuffer>` is not decoration: a plain `Uint8Array` may be backed
// by a SharedArrayBuffer as far as the type system knows, and `new Blob([…])`
// will not take one.
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
