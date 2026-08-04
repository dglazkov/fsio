interface FileSystemHandle { readonly kind: "file" | "directory"; readonly name: string }
interface FileSystemFileHandle extends FileSystemHandle { getFile(): Promise<File>; createWritable(): Promise<FileSystemWritableFileStream> }
interface FileSystemWritableFileStream extends WritableStream { write(data: string | BufferSource | Blob): Promise<void>; close(): Promise<void> }
interface FileSystemDirectoryHandle extends FileSystemHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}
interface Window { showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle> }
