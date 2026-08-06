// Files, as the page sees them.
//
// Two ways a file reaches a tab, and the difference between them is the whole
// point of this file:
//
//   open   a window. The page holds a path and reads the bytes through the
//          grant it already has, every time. Edit the file and the tab
//          follows; delete it and the tab says so.
//   fling  a copy. The page reads the bytes once and takes custody of them,
//          so the tab keeps working with the file deleted, the host stopped
//          and the folder revoked.
//
// **Both take paths inside the pewter, and nothing else.** Settled with the
// owner as this slice started: the page can already look at everything in the
// folder it was granted, so neither command has to move bytes — a fling is the
// page reading the same file twice with different intentions about the second
// read. What that buys is that `pewt fling` costs no frames and has no size
// limit of its own; what it costs is that a file outside the pewter cannot be
// sent at all. Whether the command line should ever ship bytes waits for
// somebody who wants that (https://github.com/dglazkov/fsio/issues/176).
//
// Harvested from `actuator-demo/src/model.ts`, which had the same two verbs
// and answered a different question with them: there the terminal read the
// file and the bytes rode the wire, because that demo's point was that a page
// can be handed something from outside its folder.

/** One file the page has custody of. The bytes are in a blob store beside
 *  this catalog (pewter-shell/web/db.ts); everything a list needs is here, so
 *  `pewt files` never opens a blob to render a row. */
export interface HeldFile {
  id: string;
  /** basename, as it was flung. */
  name: string;
  /** where in the pewter it came from — provenance, and what a re-fling of
   *  the same path supersedes on. The page can still read that path; a held
   *  copy is deliberately not looking at it. */
  from: string;
  type: string;
  size: number;
  /** when it landed here. */
  at: number;
}

/** A folder-relative path, or null if it is not one the page may read.
 *
 *  The page's reach is exactly the folder it was granted, so a path that
 *  climbs out of it, starts at the root, or names a drive is refused here
 *  rather than resolved and refused later by Chrome. Both ends run this: the
 *  command line to turn what you typed into what travels, and the page to
 *  check what arrived — anything that can write the folder can write anything
 *  (spec/PROTOCOL.md, threat model). */
export function safeRelPath(input: unknown): string | null {
  if (typeof input !== "string" || input === "") return null;
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) return null;
  if (input.includes("\0") || input.includes("\\")) return null;
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

export const basename = (path: string): string => path.split("/").pop() || path;

export const newFileId = (): string => `file-${Math.random().toString(16).slice(2, 10)}`;

const TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", jsonl: "application/json",
  js: "text/javascript", mjs: "text/javascript", ts: "text/typescript",
  css: "text/css", html: "text/html", xml: "text/xml", yml: "text/yaml", yaml: "text/yaml",
  csv: "text/csv", log: "text/plain", sh: "text/plain", toml: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  pdf: "application/pdf",
};

/** A guess from the extension. Chrome reports one on the `File` it hands over
 *  and it is empty more often than not, so this is the fallback and usually
 *  the answer. A viewer choice is not a security boundary; sniffing content
 *  would be a bigger lie than the extension. */
export function mimeFor(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Which viewer a file gets. Text and image are the two the shell has;
 *  everything else says so rather than rendering mojibake. Adding a third is
 *  a case here and a branch in the viewer component, which is what "various
 *  viewers" has to mean before it means anything. */
export function viewerFor(type: string): "text" | "image" | "none" {
  if (type === "image/svg+xml" || type === "application/json") return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  return "none";
}

/** Bytes, as a terminal and a footer both want them read. */
export const sizeText = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
