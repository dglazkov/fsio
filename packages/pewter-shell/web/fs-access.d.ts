// File System Access surfaces lib.dom doesn't ship yet. Minimal: only what
// the shell uses. Delete members as they land in TS.

type FsaPermissionState = "granted" | "denied" | "prompt";

interface FileSystemHandle {
  queryPermission(opts?: { mode?: "read" | "readwrite" }): Promise<FsaPermissionState>;
  requestPermission(opts?: { mode?: "read" | "readwrite" }): Promise<FsaPermissionState>;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

declare function showDirectoryPicker(opts?: {
  mode?: "read" | "readwrite";
  id?: string;
}): Promise<FileSystemDirectoryHandle>;
