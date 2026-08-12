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
export {};
//# sourceMappingURL=fs.js.map