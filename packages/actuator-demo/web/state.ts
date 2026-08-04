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

export const folder = signal<{ name: string; via: "picked" | "restored" | "regranted" } | null>(null);
export const reconnectTo = signal<FileSystemDirectoryHandle | null>(null);
export const pickError = signal<string>("");

/** The application itself — the thing being actuated. It is a page-owned
 *  signal backed by IndexedDB, and deliberately not derived from anything
 *  in the folder: the folder carries commands, never state. */
export const app = signal<AppState>({ tabs: [], activeId: null });

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
