// Shared page state: signals are the spine (terminal-demo's shape). The
// protocol-facing modules (connection.ts, agent.ts, workspace.ts) write
// these; components render from them and stay framework-thin.
import { computed, signal } from "@lit-labs/signals";
import type { Signal } from "@lit-labs/signals";
import type { FsioSession } from "@fsio/client";
import type { PastConversation } from "../src/transcripts.js";
import type { StickyRecord } from "../src/resume.js";
import type { Adoptable } from "./discovery";
import type { AgentSession } from "./agent";

export type { PastConversation, Adoptable };

/** boot — deciding; wizard — setup dialog; reconnect — a remembered folder
 *  whose grant needs one click back (#58's shape, F15); resume-error — a
 *  session that is probably still running and that we failed to rejoin
 *  (#115: the page stops here rather than starting a second conversation
 *  on top of it); pick-session — conversations running in this folder that
 *  nothing here has a record of (#117); chat — the app. */
export type Phase = "boot" | "wizard" | "reconnect" | "resume-error" | "pick-session" | "chat";
export const phase = signal<Phase>("boot");
/** The remembered handle waiting on that click. `requestPermission` needs a
 *  user activation (F15), so this is a button the human presses, never
 *  something the page can do for them. */
export const reconnectTo = signal<FileSystemDirectoryHandle | null>(null);
/** 1 run the helper · 2 pick the folder · 3 the agent. Step 3 only appears
 *  when there is a choice to make or an install to do (#102): with exactly
 *  one agent installed the page names it and goes. */
export const wizardStep = signal<1 | 2 | 3>(1);

/** Hard gate (non-Chromium browser): replaces the wizard outright. */
export const gate = signal<{ msg: string; hint: string } | null>(null);
export const pickError = signal<{ msg: string; hint: string } | null>(null);
/** Why rejoining a remembered session failed (#115). Distinct from
 *  `pickError` because the remedy is different: the folder is fine, the
 *  session is probably fine, and the honest options are "try again" or
 *  "leave it running and start another" — never a silent second
 *  conversation. */
export const resumeError = signal<{ msg: string; hint: string } | null>(null);
export const notice = signal<{ msg: string; hint: string } | null>(null);

export const folder = signal<{ name: string; via: "picked" | "restored" | "regranted" } | null>(null);

/** Running conversations in this folder that nothing here has a record of
 *  (#117), as the arrival picker sees them: everything running, minus what
 *  this page already holds and what it has been told to leave alone. The
 *  record is a shortcut back to one session; the folder is the index of all
 *  of them, and this is what it answered. */
export const adoptable = signal<Adoptable[]>([]);
/** The same question asked by the "+" menu instead (#120). One list, two
 *  exclusions: the arrival picker must not re-offer a conversation the human
 *  just walked away from, and the "+" menu must, because opening it *is* the
 *  human asking. */
export const joinable = signal<Adoptable[]>([]);

export type HelperState = "none" | "silent" | "alive" | "wrong-kind";
export const helper = signal<HelperState>("none");

/** One line of the helper's agent roster (#102) — read from the service
 *  directory, never guessed. `asks` is the field that matters: it says
 *  whether this agent will send the consent question this demo exists to
 *  render, and it is measured (F30, #100), not marketing. */
export interface AgentOffer {
  name: string;
  title: string;
  install: string;
  installed: boolean;
  asks: boolean;
}
/** What the helper reports it can serve. Empty means "the helper published
 *  a roster and it is empty"; `null` means it published none at all — an
 *  older helper, which the page treats as "not supported" rather than as an
 *  error (D25) and lets choose for itself. */
export const agents = signal<AgentOffer[] | null>(null);

/** What the host said about the agent it started. Confinement and state
 *  posture are session facts the page READS, never assumes (#18). */
export interface AgentFacts {
  agent: string;
  title: string;
  sandboxed: boolean;
  confinement: string;
  profile: string | null;
  state: { mode: string; dirs: string[]; why: string };
  cwd: string;
}

/** What this folder kept from conversations that ended (#119, D26 rule 4).
 *  Refreshed on connect and whenever a session ends. Rows are parsed
 *  defensively in `../src/transcripts.ts` — a transcript is a file any
 *  co-tenant of the folder can write (D20). */
export const past = signal<PastConversation[]>([]);
/** The one being read, or null for the live conversation. While it is set
 *  the chat pane is a document: no composer, nothing clickable, nothing on
 *  the wire. */
export const viewing = signal<PastConversation | null>(null);
/** Whether the conversation being read has its human half, and how much of
 *  it (#123) — null when this browser did not drive it, which is the state
 *  every transcript was in before the record was demoted rather than
 *  deleted. `placed` is false when the anchors no longer line up with the
 *  segments the folder kept: the turns are all there, in the wrong places.
 *  The banner reads this, because "what you are looking at is half a
 *  conversation" and "…is the whole of one" are different documents.
 *
 *  `adopted` is a third state between them (#117): the browser has a half,
 *  but only from the point the page joined the conversation — before that
 *  there are no turns anywhere. */
export const viewingHalf = signal<{ prompts: number; placed: boolean; adopted: boolean } | null>(null);

export type Turn = "starting" | "idle" | "thinking" | "cancelling" | "gone";

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
  locations: Signal.State<string[]>;
  detail: Signal.State<string>;
}
/** The reason this demo exists: the agent's own consent question, rendered
 *  by the page that can also show you the file it is about. */
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
  /** read out of an ended session's transcript (#119). The question is in
   *  the folder; the answer never was — it rode the uplink, which is not
   *  logged. So the card shows what was asked, and what it can say about the
   *  verdict depends on who is reading (#123): this browser kept what it
   *  clicked, so `answer` is set for a conversation it drove, and stays null
   *  for one it did not — where the honest thing is to say it is not
   *  knowable from here, rather than inferring it from what the agent did
   *  next — a guess dressed as a fact. */
  historic?: true;
}
export interface NoteEntry {
  kind: "note" | "error";
  text: string;
}
export type Entry = UserEntry | TextEntry | ToolEntry | PermissionEntry | NoteEntry;

/** The conversation being *read* (#119) — a document, kept apart from the
 *  live one on purpose. The agent may still be mid-turn while someone opens
 *  a past conversation; one list would let its words land in the middle of
 *  a transcript about a different session, and would lose them on the way
 *  back. Two lists mean "close" returns to a live conversation that carried
 *  on without being watched. */
export const pastEntries = signal<Entry[]>([]);

export function pushPast(e: Entry): Entry {
  pastEntries.set([...pastEntries.get(), e]);
  return e;
}

/** Where a given AgentSession's output goes. Passed to the session rather
 *  than chosen at each call site: which conversation a message belongs to
 *  is a property of the session that produced it, never of the moment it
 *  arrives. */
export type EntrySink = (e: Entry) => Entry;

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
// ------------------------------------------------------------ conversations
//
// N of them (#120). Everything that used to be one page-wide signal — the
// transcript, the turn, the queue, the agent's facts, the diagnostics — is a
// field on a conversation now, because the page holds several and they are
// all live at once. A message arriving belongs to the session that produced
// it, never to whichever conversation happens to be on screen when it lands.
//
// What stayed page-wide is what belongs to the *folder*: the file list, the
// past conversations, the helper's roster, the grant itself. One folder, N
// conversations in it — which is also the protocol's own shape, since
// `FsioClient` has always carried N sessions and it was only the page that
// insisted on one.

export interface Conv {
  /** the fsio session id, which is also the tab's identity and what rides in
   *  the URL (P1, #120). Deliberately not a page-minted tab number: a
   *  conversation is not this page's to name — it lives in the helper, the
   *  folder lists it, and a second browser has to be able to mean the same
   *  one by the same word. */
  readonly id: string;
  session: FsioSession | null;
  agent: AgentSession | null;
  readonly entries: Signal.State<Entry[]>;
  readonly turn: Signal.State<Turn>;
  /** Prompts typed while the agent was busy, oldest first.
   *
   *  ACP has one turn in flight per session, so a second prompt cannot simply
   *  be sent. The composer used to answer that by dropping the text: it
   *  cleared the textarea and `sendPrompt` discarded anything that arrived
   *  outside `idle`, so typing during a turn lost what you typed. Holding it
   *  here instead means the page keeps the one thing it has that the human
   *  cannot get back. */
  readonly queued: Signal.State<string[]>;
  /** What the host said about the agent it started (read from the host, never assumed). */
  readonly facts: Signal.State<AgentFacts | null>;
  /** Last snapshot of `acp/diagnostics`. Polled, and deliberately kept after
   *  the agent dies: the kind's methods vanish at exit (#98), so the last
   *  snapshot is all a page will ever have of the stderr that says why. */
  readonly diagnostics: Signal.State<Diagnostics | null>;
  /** True once this page is driving a session it did not start — a
   *  conversation it came back to (#113). The chat header says so; a demo
   *  that silently resumed would be indistinguishable from one that lost
   *  everything. */
  readonly resumed: Signal.State<boolean>;
  /** True when this conversation was joined in progress rather than started
   *  or resumed here. Stronger than `resumed`, and it has to be said louder:
   *  what came back is the agent's half, beginning at whatever the folder
   *  still holds, with no record anywhere of what was typed into it. */
  readonly adopted: Signal.State<boolean>;
  /** The writer epoch that took this conversation over (D18), or 0 while
   *  this page still holds it.
   *
   *  Attach IS takeover, and #120 is what made that ordinary: the URL now
   *  carries conversations, so handing someone the link — or opening the
   *  same one twice — fences whoever was there. The terminal demo has shown
   *  this since #58 and this page never did, because before there were tabs
   *  a second window on the same conversation was exotic enough to go
   *  unmentioned. It is not exotic any more, and an unmentioned fence is a
   *  page whose sends fail silently while the transcript keeps filling in
   *  with answers to questions it cannot see. */
  readonly superseded: Signal.State<number>;
  /** What the tab chip says — the agent's name once `initialize` answers. */
  readonly title: Signal.State<string>;
  /** Entries that arrived while this conversation was not on screen. With
   *  one conversation the page WAS the notification; with N, a tab that says
   *  nothing is a conversation happening in a room nobody is in. */
  readonly unread: Signal.State<number>;
  /** Permission questions this page has been asked and not answered. Its own
   *  counter rather than a scan of `entries`, because it is the one thing a
   *  background tab must be able to shout: an agent blocked on a consent
   *  question in a tab nobody is looking at is this demo's own subject
   *  matter, failing quietly. */
  readonly asking: Signal.State<number>;
  /** The sticky record this conversation writes through (resume.ts), or null
   *  when there is nothing worth coming back to yet. */
  record: StickyRecord | null;
  diagTimer?: ReturnType<typeof setInterval>;
}

export function newConv(id: string): Conv {
  return {
    id,
    session: null,
    agent: null,
    entries: signal<Entry[]>([]),
    turn: signal<Turn>("starting"),
    queued: signal<string[]>([]),
    facts: signal<AgentFacts | null>(null),
    diagnostics: signal<Diagnostics | null>(null),
    resumed: signal(false),
    adopted: signal(false),
    superseded: signal(0),
    title: signal("agent"),
    unread: signal(0),
    asking: signal(0),
    record: null,
  };
}

/** Open conversations, in tab order. */
export const convs = signal<Conv[]>([]);
/** Which one is on screen, by session id. */
export const activeId = signal<string | null>(null);
export const active = computed<Conv | null>(() => convs.get().find((c) => c.id === activeId.get()) ?? null);

// The active conversation's fields, for the components that render exactly
// one at a time. Reading through `active` rather than being handed a Conv is
// what kept the chat pane and the bar as thin as they were before there were
// tabs — and the empty defaults are what the page shows between the last tab
// closing and the next one opening.
export const entries = computed<Entry[]>(() => active.get()?.entries.get() ?? []);
export const turn = computed<Turn>(() => active.get()?.turn.get() ?? "starting");
export const queued = computed<string[]>(() => active.get()?.queued.get() ?? []);
export const agentFacts = computed<AgentFacts | null>(() => active.get()?.facts.get() ?? null);
export const diagnostics = computed<Diagnostics | null>(() => active.get()?.diagnostics.get() ?? null);
export const resumed = computed<boolean>(() => active.get()?.resumed.get() ?? false);
export const adopted = computed<boolean>(() => active.get()?.adopted.get() ?? false);
export const superseded = computed<number>(() => active.get()?.superseded.get() ?? 0);

/** Everything an `AgentSession` does that is not ACP: where its output goes,
 *  what the turn is, and what gets written down.
 *
 *  It used to read all of that from module state, which is exactly what made
 *  one conversation per page a structural fact rather than a choice. Handing
 *  it a channel instead is what N conversations cost: an arriving message
 *  belongs to the session that produced it, and now it says so. The
 *  read-only view (#119) passes a channel with no wire behind it and nothing
 *  that can act, which is the same statement from the other end. */
export interface ConvIO {
  push: EntrySink;
  /** the entry list changed in place — a card's buttons became a verdict. */
  touch(): void;
  turn(): Turn;
  setTurn(t: Turn): void;
  setQueued(q: readonly string[]): void;
  /** an unanswered permission question arrived (+1) or was answered (−1). */
  waiting(delta: number): void;
  /** this page can still READ this conversation but no longer drives it: a
   *  superseded writer (D18), or a stored transcript, which is the same
   *  statement made permanent. Everything that would act on the agent's
   *  behalf has to ask, because the answer decides whether a request is ours
   *  to serve or somebody else's. */
  fenced(): boolean;
  record(): StickyRecord | null;
  update(fn: (r: StickyRecord) => void): void;
}
