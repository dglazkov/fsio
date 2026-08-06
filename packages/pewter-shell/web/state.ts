// Page state, as signals. The components render from these; session.ts and
// tabs.ts write them. The plain modules stay framework-free.
import { signal } from "@lit-labs/signals";
import { noTabs, type TabsState } from "pewter";

/** Which face the shell shows.
 *  setup — no folder yet.
 *  live — connected to a host, showing an extension. */
export type Phase = "setup" | "live";
export const phase = signal<Phase>("setup");

/** Hard gate (a browser without the File System Access API): replaces the
 *  setup panel outright, because without a folder there is no Pewter. */
export const gate = signal<{ msg: string; hint: string } | null>(null);

export const folder = signal<string>("");
export const pickError = signal<string>("");

/** A folder that arrived by drag-and-drop and has not been allowed yet.
 *
 *  A dropped handle is real but starts at `prompt` for writing, and
 *  `requestPermission` needs a user activation (F15) — so the drop and the
 *  allow are two gestures, and this signal is the state between them. It is
 *  also the whole reason the rig can drive this page: a drop can be
 *  synthesized (F14) and a picker cannot. */
export const pending = signal<FileSystemDirectoryHandle | null>(null);

/** Whether a host is answering in the folder we hold. A pewter with no host
 *  is a page that can see the folder and ask it nothing. */
export const host = signal<"none" | "alive" | "silent">("none");

/** Every tab this page holds, and which one is on screen.
 *
 *  The page owns this and nothing else does. It is not in the folder, it is
 *  not in the host, and it does not survive the tab being closed — which is
 *  why `pewt tabs` in a terminal is a question the host has to forward here
 *  rather than answer (packages/pewt/src/router.ts). */
export const tabs = signal<TabsState>(noTabs());

/** What the host built for each open tab, by tab id. Provenance rather than
 *  state: the bytes are in the frame, and this is what the footer and the
 *  report say about where they came from. */
export interface OpenExtension {
  name: string;
  /** the bundle the host built, as it reported it. */
  hash: string;
  bytes: number;
  rebuilt: boolean;
}
export const opened = signal<Record<string, OpenExtension>>({});
export const extError = signal<string>("");

/** Calls an extension has made through the API, newest last. The rig reads
 *  this to know the round trip happened; a human reads it to see that the
 *  screen in front of them is asking for things. */
/** A type alias rather than an interface on purpose: the reporter takes
 *  `Record<string, unknown>[]`, and only an alias carries the implicit index
 *  signature that makes one assignable to the other. */
export type ServedCall = {
  method: string;
  ok: boolean;
  ms: number;
};
export const served = signal<ServedCall[]>([]);

/** Whether the extension's frame really has an origin of its own. Measured
 *  rather than assumed — see bridge.ts. */
export const opaque = signal<boolean | null>(null);
