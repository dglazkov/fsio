// The FS surface fsio actually uses — a structural subset of the File
// System Access API. The real browser handles (FileSystemDirectoryHandle
// & friends) satisfy these interfaces as-is; so does a Node shim over real
// `fs` (TESTING.md B1), which is what makes the client testable per push
// without a browser (D11).
//
// Why not the lib.dom types directly:
//   (a) the published .d.ts stays lib-agnostic — Node consumers compile
//       without lib.dom;
//   (b) the contract documents exactly which platform behaviors the client
//       depends on (atomic close() commits, point-in-time snapshots).

export interface FsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile>;
  /** Entry names; used only for uplink-backlog introspection (labs, #4). */
  keys(): AsyncIterable<string>;
}

export interface FsFile {
  /** A point-in-time snapshot. Snapshot reads MAY fail transiently if the
   *  other side writes between getFile() and the read (NotReadableError,
   *  spec/FINDINGS.md F11) — callers re-read on the next wakeup. */
  getFile(): Promise<FsSnapshot>;
  createWritable(): Promise<FsWritable>;
}

/** The DOM File, structurally: enough to size, read, and slice from a byte
 *  offset (segment draining reads tails, not whole files). */
export interface FsSnapshot {
  readonly size: number;
  readonly lastModified: number;
  text(): Promise<string>;
  slice(start: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** write()s accumulate; close() is the atomic commit point (D2: chunk
 *  files appear complete or not at all). */
export interface FsWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
}
