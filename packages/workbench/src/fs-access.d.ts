// File System Access / Observer surfaces that lib.dom doesn't ship yet.
// Minimal: only what the workbench uses. Delete members as they land in TS.

interface FileSystemChangeRecord {
  type: string;
  relativePathComponents?: string[];
}

declare class FileSystemObserver {
  constructor(cb: (records: FileSystemChangeRecord[]) => void);
  observe(handle: FileSystemHandle, opts?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

declare function showDirectoryPicker(opts?: {
  mode?: "read" | "readwrite";
  id?: string;
}): Promise<FileSystemDirectoryHandle>;
