// Shared page state: signals are the spine (terminal-demo's shape). The
// protocol-facing modules (connection.ts, agent.ts, workspace.ts) write
// these; components render from them and stay framework-thin.
import { signal } from "@lit-labs/signals";
import type { Signal } from "@lit-labs/signals";

/** boot — deciding; wizard — setup dialog; chat — the app. */
export type Phase = "boot" | "wizard" | "chat";
export const phase = signal<Phase>("boot");
export const wizardStep = signal<1 | 2>(1);

/** Hard gate (non-Chromium browser): replaces the wizard outright. */
export const gate = signal<{ msg: string; hint: string } | null>(null);
export const pickError = signal<{ msg: string; hint: string } | null>(null);
export const notice = signal<{ msg: string; hint: string } | null>(null);

export const folder = signal<{ name: string } | null>(null);

export type HelperState = "none" | "silent" | "alive" | "wrong-kind";
export const helper = signal<HelperState>("none");

/** What the host said about the agent it started (D30 rule 5: confinement
 *  and state posture are session facts the page READS, never assumes). */
export interface AgentFacts {
  agent: string;
  title: string;
  sandboxed: boolean;
  confinement: string;
  profile: string | null;
  state: { mode: string; dirs: string[]; why: string };
  cwd: string;
}
export const agentFacts = signal<AgentFacts | null>(null);

export type Turn = "starting" | "idle" | "thinking" | "cancelling" | "gone";
export const turn = signal<Turn>("starting");

// ---------------------------------------------------------------- transcript
//
// Mutable fields are nested signals: a streamed token updates one entry
// instead of rebuilding the list (the same trick TabRecord uses in the
// terminal demo, for the same reason — token rates are not click rates).

export interface UserEntry {
  kind: "user";
  text: string;
}
export interface TextEntry {
  kind: "agent" | "thought";
  text: Signal.State<string>;
}
export interface ToolEntry {
  kind: "tool";
  toolCallId: string;
  title: Signal.State<string>;
  status: Signal.State<string>;
  toolKind: string;
  locations: Signal.State<string[]>;
  detail: Signal.State<string>;
}
/** The reason this demo exists: the agent's own consent question, rendered
 *  by the page that can also show you the file it is about (R6). */
export interface PermissionEntry {
  kind: "permission";
  id: string;
  title: string;
  toolKind: string;
  locations: string[];
  detail: string;
  options: { optionId: string; name: string; kind?: string }[];
  answer: Signal.State<string | null>;
  /** resolves the agent's pending request; null once answered. */
  respond: ((optionId: string | null) => void) | null;
}
export interface NoteEntry {
  kind: "note" | "error";
  text: string;
}
export type Entry = UserEntry | TextEntry | ToolEntry | PermissionEntry | NoteEntry;

export const entries = signal<Entry[]>([]);

export function pushEntry(e: Entry): Entry {
  entries.set([...entries.get(), e]);
  return e;
}

// ---------------------------------------------------------------- workspace

export interface FileRow {
  path: string;
  size: number;
  modified: number;
  /** when this page last saw it change (for the highlight). */
  seenChanged: number;
}
export const files = signal<FileRow[]>([]);
export const workspaceNote = signal<string>("");

// ---------------------------------------------------------------- diagnostics

export interface Diagnostics {
  messagesOut: number;
  messagesIn: number;
  junkLines: number;
  refusedIn: number;
  overflows: number;
  stderr: string[];
  [k: string]: unknown;
}
/** Last snapshot of `acp/diagnostics`. Polled, and deliberately kept after
 *  the agent dies: the kind's methods vanish at exit (#98), so the last
 *  snapshot is all a page will ever have of the stderr that says why. */
export const diagnostics = signal<Diagnostics | null>(null);
