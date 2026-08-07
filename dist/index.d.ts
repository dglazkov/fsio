import { type PewtApi } from "./api.js";
export { PewtError, explain, METHODS, type PewtApi, type Project, type Bundle, type RunOptions, type RunResult, type CloneOptions, type CloneResult, type InstallOptions, type FileTabOptions, type OpenResult, type FlingResult } from "./api.js";
export { Channel, apiFor } from "./api.js";
export * from "./agent.js";
export * from "./shell.js";
export * from "./files.js";
export * from "./grants.js";
export * from "./tabs.js";
export * from "./wire.js";
export * from "./control.js";
/** What this tab was opened with — `tabs.add`'s `args`, or `undefined` when
 *  the tab was opened bare.
 *
 *  A promise rather than a value because an extension's first line runs
 *  before the shell's handshake lands; it settles when the port does, which
 *  is the same moment the first API call can be answered. It is not on
 *  `pewt` because `pewt` mirrors the operation table and this is not an
 *  operation — nothing is asked, it is what arrived with the tab. */
export declare const args: Promise<unknown>;
/** Take the port the shell offers. Exported so the shell's own tests — and
 *  anything driving an extension outside a browser — can hand one over
 *  directly instead of staging a window message. */
export declare function connectTo(port: MessagePort, openArgs?: unknown): void;
/** The API. Everything an extension can ask for, and nothing else. */
export declare const pewt: PewtApi;
//# sourceMappingURL=index.d.ts.map