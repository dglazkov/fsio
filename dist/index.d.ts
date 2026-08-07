import { type PewtApi } from "./api.js";
export { PewtError, METHODS, type PewtApi, type Project, type Bundle, type RunOptions, type RunResult, type CloneOptions, type CloneResult, type InstallOptions, type FileTabOptions, type OpenResult, type FlingResult } from "./api.js";
export { Channel, apiFor } from "./api.js";
export * from "./agent.js";
export * from "./shell.js";
export * from "./files.js";
export * from "./grants.js";
export * from "./tabs.js";
export * from "./wire.js";
export * from "./control.js";
/** Take the port the shell offers. Exported so the shell's own tests — and
 *  anything driving an extension outside a browser — can hand one over
 *  directly instead of staging a window message. */
export declare function connectTo(port: MessagePort): void;
/** The API. Everything an extension can ask for, and nothing else. */
export declare const pewt: PewtApi;
//# sourceMappingURL=index.d.ts.map