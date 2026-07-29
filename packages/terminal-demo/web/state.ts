// Shared page state (#34): signals are the spine. Components render from
// these; the plain modules (connection.ts, tabs.ts) write them. The Lit
// layer stays thin and the protocol-facing code stays framework-free.
import { signal, computed } from "@lit-labs/signals";
import type { Signal } from "@lit-labs/signals";
import type { FsioSession, SessionSummary } from "@fsio/client";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/** Which face the page shows.
 *  boot — deciding (revisit check in flight); no dialog, idle pane.
 *  wizard — setup dialog (steps: run helper / pick folder).
 *  reconnect — #58 fast path: one-button re-grant offer.
 *  picker — connected, resumable sessions offered before the first tab.
 *  shell — dialog dissolved; tabs own the page. */
export type Phase = "boot" | "wizard" | "reconnect" | "picker" | "shell";
export const phase = signal<Phase>("boot");

/** Which wizard step is showing (1 = run helper, 2 = pick folder). */
export const wizardStep = signal<1 | 2>(1);

/** Hard gate (non-Chromium browser): replaces the wizard outright. */
export const gate = signal<{ msg: string; hint: string } | null>(null);

export const folder = signal<{ name: string; via: "picked" | "restored" | "regranted" } | null>(null);

/** Saved handle awaiting a re-grant click (permission "prompt", F15). */
export const reconnectTo = signal<FileSystemDirectoryHandle | null>(null);

export type HelperState = "none" | "silent" | "alive";
export const helper = signal<HelperState>("none");

/** Wrong-folder / unreadable-.fsio recovery, rendered inline in the wizard. */
export const pickError = signal<{ msg: string; hint: string } | null>(null);

/** listSessions() poll, filtered to resumable shells not already in a tab.
 *  Feeds both the wizard's picker panel and the tab strip's "+" menu. */
export const resumable = signal<SessionSummary[]>([]);

/** Transient error banner (spawn refused, send failed, …). */
export const notice = signal<{ msg: string; hint: string } | null>(null);

export type TabPhase = "starting" | "running" | "exited" | "superseded" | "failed";

/** One tab = one xterm + one session. The xterm trio (host/term/fit) is an
 *  imperative island — Lit renders chrome around the slot, never inside the
 *  host div. Per-tab reactive fields are nested signals so tab chips and
 *  overlays update without rebuilding the tabs array. */
export interface TabRecord {
  readonly tabId: number;
  sessionId: string | null;
  session: FsioSession | null;
  readonly title: Signal.State<string>;
  readonly state: Signal.State<TabPhase>;
  /** Status-bar / overlay text for the current state. */
  readonly detail: Signal.State<string>;
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  readonly fit: FitAddon;
}

export const tabs = signal<TabRecord[]>([]);
export const activeTabId = signal<number | null>(null);
export const activeTab = computed<TabRecord | null>(
  () => tabs.get().find((t) => t.tabId === activeTabId.get()) ?? null
);
