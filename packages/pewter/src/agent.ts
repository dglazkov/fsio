// An agent, as an extension holds one.
//
// Pewter ships no agent and is not an ACP client. It speaks the Agent Client
// Protocol in the sense that it carries it: an adapter is an ordinary process
// on your machine, its stdio rides the folder, and one message crosses in one
// piece in each direction. **The extension is the client.**
//
// That is not an accident of layering, it is the point. `session/request_
// permission` and `fs/read_text_file` arrive as requests *from* the agent,
// and the party that should answer them is the one with the human and the
// folder — which is the tab, not the host. An API that answered them here
// would be deciding on the tab's behalf what the human would have said.
//
// So what this hands over is messages. Correlating ids, answering requests,
// and drawing whatever a permission question should look like are the
// extension's, and the agent tab is where they belong.

/** What to ask for. */
export interface AgentOptions {
  /** an adapter name from `pewt.agents.list()`, or omit it and take whichever
   *  this pewter has. A page cannot know what is installed, so omitting is
   *  the common case and stays safe: the host chooses from its own roster. */
  agent?: string;
  /** a project under `repos/`. Omit it for the pewter itself. */
  repo?: string;
  /** one complete ACP message from the agent. Never half of one: the host
   *  guarantees a frame boundary is a message boundary, which is why there is
   *  no buffer anywhere on this side. */
  onMessage?: (message: unknown) => void;
}

/** One adapter this pewter could run. Prose, names and versions — never a
 *  path: where npm put a binary is not something a tab needs to use it. */
export interface AgentEntry {
  name: string;
  title: string;
  /** the npm package that provides it. */
  pkg: string;
  /** what to type to add it. */
  install: string;
  /** is it a dependency of this pewter, with its binary linked? */
  installed: boolean;
  version: string | null;
  /** does it send `session/request_permission` before it changes a file? */
  /** null when nobody measured it — an adapter this build does not know.
   *  Three states: "it asks", "it does not", and "nobody checked", which is
   *  not the same claim and must not be shown as one. */
  asks: boolean | null;
  /** the version `asks` was measured against. */
  measured: string;
  /** true when the installed version is not the measured one, so `asks`
   *  describes a different build. Show it; a column that is quietly about
   *  other software is worse than no column. */
  unmeasured: boolean;
}

/** An agent that is running. */
export interface Agent {
  /** send one complete ACP message. Not a string and not a chunk — the shape
   *  that would break the framing contract is not sayable. */
  send(message: unknown): void;
  /** stop it. The host stops what it started (D6). */
  close(): void;
  /** what the host said it started. Set before `pewt.agent()` resolves — the
   *  same event carries both — so a tab can draw a header and name a cwd
   *  without asking a second question. */
  readonly info: AgentStarted;
  /** the adapter's exit code, or null when it died on a signal or the host
   *  went away. */
  readonly exit: Promise<number | null>;
}

/** What a started agent reports about itself, so a tab can draw a header
 *  without asking a second question. */
export interface AgentStarted {
  agent: string;
  title: string;
  version: string | null;
  /** null when nobody measured it — an adapter this build does not know.
   *  Three states: "it asks", "it does not", and "nobody checked", which is
   *  not the same claim and must not be shown as one. */
  asks: boolean | null;
  unmeasured: boolean;
  /** the working directory, relative to the pewter. */
  where: string;
  /** the same directory, absolute — because ACP's `session/new` requires an
   *  absolute cwd and the tab is the ACP client. The one path that crosses
   *  to the page, on `acp-demo`'s recorded precedent (`acp/info`): it is a
   *  label for the folder the page was already granted, not a disclosure of
   *  anything beyond it. */
  cwd: string;
}

/** Options → the spec that goes on the wire. Trivial, and here rather than
 *  inline so the command line and an extension cannot spell it differently
 *  (the `shell` slice's lesson, for the same reason). */
export function agentSpec(options: AgentOptions = {}): { agent?: string; repo?: string } {
  return {
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
  };
}

/** The one fact worth reading before starting an agent, in words, for all
 *  three states.
 *
 *  Here rather than at each call site because there were four of them — the
 *  host's question, `pewt agents`, `pewt agent --dry-run`, and the screen —
 *  and the third one was found saying "it edits with its own hands" about an
 *  adapter nobody had measured, which is a claim rather than a gap. Both
 *  sides of the wire spell this shape, so both sides say it the same way. */
export function describeAsks(asks: boolean | null): string {
  if (asks === null) return "nobody has measured whether it asks before it edits";
  return asks ? "asks before it edits" : "edits with its own hands";
}
