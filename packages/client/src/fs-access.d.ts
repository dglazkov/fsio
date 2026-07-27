// FileSystemObserver isn't in lib.dom yet. Compile-time only: this ambient
// file is not emitted to dist/, and no public type references it (the
// observer is an ES #private field). Delete when TS ships it.

interface FileSystemChangeRecord {
  type: string;
  relativePathComponents?: string[];
}

declare class FileSystemObserver {
  constructor(cb: (records: FileSystemChangeRecord[]) => void);
  observe(handle: unknown, opts?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}
