// Page state, as signals. The components render from these; session.ts and
// db.ts write them. The plain modules stay framework-free.
import { signal } from "@lit-labs/signals";
import type { AppState } from "../src/model";

/** Which face the page shows.
 *  boot — deciding (checking for a remembered folder).
 *  setup — the folder has not been granted yet.
 *  reconnect — a remembered folder needs one click to re-grant (F15).
 *  live — connected; the app is being actuated. */
export type Phase = "boot" | "setup" | "reconnect" | "live";
export const phase = signal<Phase>("boot");

/** Hard gate (non-Chromium browser): replaces the setup panel outright. */
export const gate = signal<{ msg: string; hint: string } | null>(null);

/** The setup panel, waved off. Only reachable when the page is holding
 *  files: a page with flung files in it is a working app that happens not
 *  to be connected to anything, and a modal it cannot dismiss would be the
 *  demo contradicting its own claim (P6 — the bottom rung is a
 *  destination). The footer is the way back. */
export const setupHidden = signal(false);

export const folder = signal<{ name: string; via: "picked" | "restored" | "regranted" } | null>(null);
export const reconnectTo = signal<FileSystemDirectoryHandle | null>(null);
export const pickError = signal<string>("");

/** The application itself — the thing being actuated. It is a page-owned
 *  signal backed by IndexedDB, and deliberately not derived from anything
 *  in the folder: the folder carries commands, never state. */
export const app = signal<AppState>({ tabs: [], activeId: null, held: [] });

/** One file in the granted folder, as the sidebar shows it. Read straight
 *  off the directory handle (folder.ts) — nothing about this list rides the
 *  session, and nothing in it belongs to the page. */
export interface FileRow {
  path: string;
  size: number;
  modified: number;
  /** when this page noticed it move, for the fade. 0 = never. */
  seenChanged: number;
}
export const folderFiles = signal<FileRow[]>([]);
export const folderNote = signal<string>("no folder");

/** Is the files pane showing? Only consulted at widths too narrow to give it
 *  a column of its own, where it becomes a drawer. It used to be `display:
 *  none` below the breakpoint — the pane simply gone, with nothing on screen
 *  saying it had ever been there, which for this demo takes the second act
 *  with it: the bottom half of that pane is the page's own custody of its
 *  files. Closed by default, because the tab you are reading is what a narrow
 *  window has room for. */
export const filesOpen = signal(false);

/** The bytes behind one tab, loaded (content.ts). Keyed `local:<path>` or
 *  `held:<fileId>`; a viewer of "none" is a file this demo cannot show, and
 *  `missing` is a reference whose file is gone — the honest end state of an
 *  opened file whose folder went away. */
export interface Loaded {
  key: string;
  viewer: "text" | "image" | "none";
  type: string;
  size: number;
  text: string | null;
  url: string | null;
  truncated: boolean;
  missing: boolean;
  loadedAt: number;
}
export const content = signal<Map<string, Loaded>>(new Map());

/** Is a helper answering in this folder? "silent" is a helper that was
 *  there and stopped — worth saying, because every command will now fail. */
export type HelperState = "none" | "silent" | "alive";
export const helper = signal<HelperState>("none");

/** The last operation this page applied, for the activity line. Seeing the
 *  page react is the demo; seeing *what* it reacted to is the proof — and
 *  `origin` is the other half of it: the same five operations arrive from a
 *  terminal and from a click on this page, and the app cannot tell which
 *  is which. */
export const lastCommand = signal<{
  method: string;
  ok: boolean;
  detail: string;
  origin: "cli" | "page";
} | null>(null);

/** Another page took this folder over (newest wins). This one still holds
 *  its own state and still renders — it is just not the one being driven. */
export const displaced = signal(false);
