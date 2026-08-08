// Page state, as signals. The components render from these; session.ts and
// tabs.ts write them. The plain modules stay framework-free.
import { signal } from "@lit-labs/signals";
import { noTabs, type Extension, type TabsState, type Trouble } from "pewter";

/** What the host calls this pewter. It arrives with the session, and it is
 *  what the page's own storage is keyed by: one origin serves every pewter
 *  anybody opens, so the copies `pewt fling` made here must not show up in
 *  another folder's page (db.ts). */
export const pewterName = signal<string>("");

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

/** The folder this page held last time, when its grant needs one click back.
 *
 *  Set by `revisit()` when the remembered handle's permission is `prompt` —
 *  the usual answer on a reload, because `requestPermission` needs a user
 *  activation (F15). The setup panel turns it into a reconnect offer with a
 *  button, and "not this folder" clears it and forgets the handle. */
export const reconnectTo = signal<FileSystemDirectoryHandle | null>(null);

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

/** What broke inside an extension's frame, newest last (#210).
 *
 *  An extension's console is inside an opaque-origin iframe: a human has to
 *  think to open devtools, and an agent that wrote the screen cannot open one
 *  at all. So the frame reports what escaped and this is where it lands —
 *  read by the footer, and written into `report.json`, which is a file in the
 *  folder the person or agent doing the fixing is already looking at.
 *
 *  Kept whole rather than counted: a stack is the useful half, and a count
 *  tells you only that today was worse than yesterday. */
export interface FrameTrouble extends Trouble {
  /** which extension's frame it came out of. */
  from: string;
  /** when, so a report says whether this is the run you are looking at. */
  at_ms: number;
}
export const troubles = signal<FrameTrouble[]>([]);

/** What `extensions/` holds, for the strip's opener — null until it is asked
 *  for, and asked for again every time the menu opens, because the folder is
 *  the list and a screen written a minute ago should be on it (#187). */
export const screens = signal<Extension[] | null>(null);
export const screensError = signal<string>("");

/** One file tab's bytes, decoded far enough to render.
 *
 *  Kept beside the tab list rather than in it, for the same reason the frames
 *  are: a tab holds a reference, and a state carrying file contents would stop
 *  being something a test can construct or a report can print. */
export interface Loaded {
  key: string;
  viewer: "text" | "image" | "none";
  type: string;
  size: number;
  /** the head of the file, for a text view. */
  text: string | null;
  /** an object URL, for an image view. Revoked when this entry is replaced or
   *  forgotten — a page that never forgets pins every image it ever showed. */
  url: string | null;
  truncated: boolean;
  /** the file is not there. Normal for a window (`pewt open`), and the whole
   *  difference a copy (`pewt fling`) is for. */
  missing: boolean;
  loadedAt: number;
}

/** What each open file tab is showing, by reference key (files.ts). */
export const content = signal<Map<string, Loaded>>(new Map());

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
