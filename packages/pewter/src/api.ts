// `pewt` — what an extension calls.
//
// There is no plugin API to learn. `pewt.repos.list()` is the same operation
// as typing `pewt repos`, and it reaches everything the command line
// reaches: both are clients of one host, and the host has one table.
//
// What this file adds over "post a message" is the part an extension author
// should not have to think about: calls made before the shell hands over the
// port are queued rather than lost, every call gets exactly one answer, and
// a refusal arrives as a thrown error carrying the operation's own code.
import { agentSpec, type Agent, type AgentEntry, type AgentOptions } from "./agent.js";
import type { HeldFile } from "./files.js";
import type { Grant } from "./grants.js";
import { shellSpec, type Shell, type ShellOptions, type ShellResult } from "./shell.js";
import { PAGE_METHODS, type Tab, type TabsListing, type TabsState } from "./tabs.js";
import { asAnswer, asEvent, send, WIRE_VERSION, type ApiError, type Call } from "./wire.js";

/** A project in this pewter — a directory under `repos/`. */
export interface Project {
  name: string;
  /** whether it is a git repository. A directory that is not one is still
   *  listed: the folder is the user's, and hiding what is in it would be a
   *  lie about their own disk. */
  git: boolean;
}

/** One extension, built. `path` is folder-relative — the shell reads it
 *  through the grant, so an extension never sees bytes it did not ask for. */
export interface Bundle {
  name: string;
  path: string;
  bytes: number;
  hash: string;
  rebuilt: boolean;
  ms?: number;
}

/** What a run does while it is running, and what it leaves behind.
 *
 *  `onOutput` is called with whole lines, in order, as the script writes
 *  them. `stream` is which of the child's two it came from — kept apart
 *  because a build's diagnostics and its output are different things. */
export interface RunOptions {
  /** a project under `repos/`. Omit it to run a script in the pewter itself. */
  repo?: string;
  onOutput?: (line: string, stream: "out" | "err") => void;
}

/** A finished run. `exitCode` is null when the process died on a signal, or
 *  when the host stopped before it ended. */
export interface RunResult {
  exitCode: number | null;
}

/** The operation said no. Thrown rather than returned, because
 *  `await pewt.repos.list()` should read like every other call an extension
 *  makes — and because an error that has to be checked for is an error that
 *  gets ignored. */
export class PewtError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "PewtError";
    this.code = error.code;
    if (error.hint !== undefined) this.hint = error.hint;
  }
}

/** The API surface, as an extension sees it.
 *
 *  It is written out rather than generated so an editor can complete it and
 *  `pewt check` can fail on it — which is the second feedback signal an
 *  agent writing an extension has, and the only one it can run alone. The
 *  price is that this interface and the host's operation table are two
 *  copies of one list; @fsio/pewt's test-api.ts fails the build when they
 *  disagree. */
/** What a clone does while it runs, and what to call the result.
 *
 *  `onOutput` is git's own lines, throttled at the host: progress repaints
 *  arrive a few times a second, real lines always. Everything a clone says —
 *  progress included — is stderr, which is git's convention, not an error. */
export interface CloneOptions {
  /** the directory name under `repos/`. Derived from the url when absent. */
  name?: string;
  onOutput?: (line: string, stream: "out" | "err") => void;
}

/** A finished clone. `exitCode` 0 is a project in `repos/`; anything else
 *  left nothing behind — a dead clone leaves no half-repo. */
export interface CloneResult {
  exitCode: number | null;
}

export interface PewtApi {
  repos: {
    /** Every project in this pewter, by name. */
    list(): Promise<{ repos: Project[] }>;
    /** Start a new project: a directory under `repos/`, `git init` run in
     *  it, nothing else. Refused if the name is taken. Asks nobody — it is a
     *  mkdir in the folder this page was already granted. */
    create(params: { name: string }): Promise<{ repo: Project }>;
    /** Clone a repository into `repos/`, streaming git's own output.
     *
     *  Resolves when git exits. Asks nobody (#189): git fetches and executes
     *  nothing it fetched. A url that needs credentials fails rather than
     *  prompts — the host runs git with no terminal to ask on — and the
     *  failure arrives in git's own words through `onOutput`. */
    clone(url: string, options?: CloneOptions): Promise<CloneResult>;
  };
  ext: {
    /** Build an extension into one self-contained HTML file. The shell calls
     *  this to open a tab; an extension calls it to rebuild a sibling. */
    bundle(params: { name: string }): Promise<Bundle>;
  };
  /** Run a script the project already declares.
   *
   *  An extension cannot invent one: the name has to be in a `package.json`
   *  you can read, so the set of runnable things is a file rather than a
   *  capability this API grants. The host asks a human before it starts
   *  anything, so this call can wait a while and can come back refused. */
  run(script: string, options?: RunOptions): Promise<RunResult>;
  /** Open a shell on your machine, in the pewter or in a project.
   *
   *  It resolves once the shell is running — which means after a human at
   *  the host's terminal has allowed it — and what it resolves to is live:
   *  write keystrokes to it, resize it, and await its exit. Bytes arrive
   *  through `onData` exactly as the pty produced them, escape sequences
   *  included, so drawing one needs a terminal emulator. This API hands over
   *  the stream and holds no opinion about what renders it. */
  shell(options?: ShellOptions): Promise<Shell>;
  agents: {
    /** Every ACP adapter this build knows, and which of them your pewter
     *  actually depends on. An adapter is an ordinary npm dependency, so this
     *  is a reading of your own `package.json` rather than a scan of your
     *  machine. */
    list(): Promise<{ agents: AgentEntry[] }>;
  };
  /** Start an agent on a project.
   *
   *  It resolves once the adapter is running — after a human at the host's
   *  terminal has allowed it — and what it resolves to is live: send it ACP
   *  messages, read them through `onMessage`, and await its exit.
   *
   *  **You are the ACP client.** Pewter carries the protocol and does not
   *  speak it, so correlating ids, answering `session/request_permission`,
   *  and serving `fs/*` through the folder are yours. That is what makes the
   *  permission question a screen somebody designed rather than a redraw in
   *  a terminal nobody can style. */
  agent(options?: AgentOptions): Promise<Agent>;
  grants: {
    /** What the host will start without asking, because somebody at its
     *  terminal answered "always" once. Reading it is how an extension can
     *  say "this will ask you" before it makes you wait for a question. */
    list(): Promise<{ grants: Grant[] }>;
    /** Take one back, so the next one asks again.
     *
     *  There is no `add` here and there will not be. A grant is made by a
     *  human typing at the host's terminal and by nothing else (P5), so the
     *  only direction this API moves is narrower. */
    revoke(params: { id: string }): Promise<{ id: string; grant: Grant }>;
  };
  /** The tabs this page is holding.
   *
   *  The first operations the *page* answers rather than the host. Everything
   *  above is a question about your machine and travels to the host; a tab is
   *  not on disk anywhere, so these are answered where they live — which for
   *  an extension is one frame away rather than a folder away, and for a
   *  terminal is a command the host forwards down the page's session.
   *
   *  Nothing here asks a human. The host's question is for things it starts
   *  on your machine, and opening a screen the folder already contains starts
   *  nothing. */
  tabs: {
    /** Every tab, in strip order, and which one is on screen. The catalog of
     *  held copies is not in it — `files.list()` is that question, and an
     *  operation answering both would make one of them impossible to ask. */
    list(): Promise<TabsListing>;
    /** Open an extension in a new tab. Refused if it does not build — the
     *  compile error comes back as the refusal, so a caller learns what is
     *  wrong without opening the tab it asked for. */
    add(params: { name: string; title?: string; activate?: boolean }): Promise<{ id: string; name: string; title: string; active: boolean }>;
    /** Rename one. The extension in it does not care and is not told. */
    update(params: { id: string; title: string }): Promise<{ id: string; title: string }>;
    /** Close one. Whatever the extension in it was doing stops with it. */
    close(params: { id: string }): Promise<{ id: string; activeId: string | null }>;
    /** Bring one forward. */
    focus(params: { id: string }): Promise<{ id: string; title: string }>;
  };
  /** Put a file from this pewter in a tab, as a window on it.
   *
   *  The page reads it through the grant it already holds, so nothing rides a
   *  session and the path is the only thing that travels. It stays a window:
   *  edit the file and the tab follows, delete it and the tab says it is gone.
   *
   *  Paths are relative to the pewter, and only inside it. A path that climbs
   *  out is refused — the page's reach is exactly the folder you granted.
   *
   *  Opening the same path twice brings the window already on it forward. */
  open(path: string, options?: FileTabOptions): Promise<OpenResult>;
  /** Take a copy of a file from this pewter into the page's custody.
   *
   *  The same one read as `open`, with a different intention about it: the
   *  bytes land in browser storage and stop needing the file, the host, or the
   *  folder. That is how a build output outlives its build directory — delete
   *  `dist/`, stop `pewt serve`, revoke the grant, and the tab still works.
   *
   *  There is no size limit of this API's own. The browser's storage quota is
   *  the limit, and running into it is a refusal naming it rather than a
   *  truncated copy.
   *
   *  Flinging the same path twice supersedes the first copy: you edited the
   *  file and threw it again, and any tab showing the old one follows over. */
  fling(path: string, options?: FileTabOptions): Promise<FlingResult>;
  files: {
    /** Every copy this page holds, oldest first. Survives a reload; the tabs
     *  that were showing them do not, which is what this list is for. */
    list(): Promise<{ files: HeldFile[] }>;
    /** Put a copy back in a tab. */
    show(params: { id: string; title?: string; activate?: boolean }): Promise<{ id: string; fileId: string; name: string; active: boolean; reused: boolean }>;
    /** Forget a copy and free its bytes. Tabs showing it close with it. */
    drop(params: { id: string }): Promise<{ id: string; name: string; closedTabs: number; activeId: string | null }>;
  };
}

/** What every file command takes besides the file: what to call the tab, and
 *  whether to bring it forward. */
export interface FileTabOptions {
  title?: string;
  activate?: boolean;
}

export interface OpenResult {
  id: string;
  path: string;
  title: string;
  active: boolean;
  /** whether a window was already on this path. */
  reused: boolean;
}

export interface FlingResult {
  /** the copy, in the catalog `files.list()` returns. */
  fileId: string;
  /** the tab showing it. */
  id: string;
  name: string;
  from: string;
  size: number;
  type: string;
  /** the copy of the same path this one replaced, if there was one. */
  superseded: string | null;
  active: boolean;
}

/** Every method this package knows how to spell, in wire form. The host's
 *  table is the authority; this is the list that gets checked against it.
 *
 *  The page's own methods are in it too, and an extension cannot tell them
 *  apart — which is the claim: one API, and where an operation is answered is
 *  the implementation's business rather than the caller's. */
export const METHODS = ["repos.list", "repos.create", "repos.clone", "ext.bundle", "agents.list", "grants.list", "grants.revoke", "run", "shell", "agent", ...PAGE_METHODS] as const;

/** The extension's end of the channel. One per extension, made by
 *  `connectTo` and used by `pewt`. */
export class Channel {
  #port: MessagePort | null = null;
  #next = 1;
  readonly #waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onEvent?: (event: unknown) => void }>();
  /** Messages made before the port arrived, in order. An extension's first
   *  render happens in the same tick as its script runs, and the port is one
   *  message later; losing those calls would make every extension start with
   *  a race. Order is what makes it safe to queue a send behind its call. */
  readonly #queued: unknown[] = [];

  attach(port: MessagePort): void {
    if (this.#port) throw new Error("this channel already has a port");
    this.#port = port;
    port.onmessage = (event: MessageEvent) => this.#onMessage(event.data);
    port.start();
    for (const message of this.#queued.splice(0)) port.postMessage(message);
  }

  get attached(): boolean {
    return this.#port !== null;
  }

  /** Make a call. `onEvent` receives whatever arrives while it is still
   *  running — nothing at all for an operation that just answers. The
   *  callback stays in this frame; only its call's id crosses the channel. */
  call(method: string, params: unknown = {}, onEvent?: (event: unknown) => void): Promise<unknown> {
    return this.open(method, params, onEvent).answer;
  }

  /** Make a call and keep its number, so more can be sent to it while it
   *  runs. `call` is this with the number thrown away, which is the right
   *  shape for every operation that answers once. */
  open(method: string, params: unknown = {}, onEvent?: (event: unknown) => void): { id: number; answer: Promise<unknown> } {
    const id = this.#next++;
    const message: Call = { v: WIRE_VERSION, id, method, params };
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, ...(onEvent ? { onEvent } : {}) });
      this.#post(message);
    });
    return { id, answer };
  }

  /** Send more to a call already in flight — a keystroke, a window size, a
   *  request to stop. Nothing comes back: what a shell has to say arrives as
   *  events on the call it belongs to. */
  send(id: number, body: unknown): void {
    // A send to a call that is already over is dropped here rather than at
    // the far end. The typical one is a keystroke racing the exit, and
    // waking the shell to be told about it helps nobody.
    if (!this.#waiting.has(id)) return;
    this.#post(send(id, body));
  }

  #post(message: unknown): void {
    if (this.#port) this.#port.postMessage(message);
    else this.#queued.push(message);
  }

  #onMessage(data: unknown): void {
    const event = asEvent(data);
    if (event) {
      // An event for a call that already ended, or one nobody is listening
      // for. Dropped: an event is news about a call, and a call that is over
      // has no news left worth throwing over.
      const waiting = this.#waiting.get(event.id);
      try {
        waiting?.onEvent?.(event.event);
      } catch {
        // The extension's own callback threw. That is its bug and its tab;
        // it must not take the run's answer down with it.
      }
      return;
    }
    const msg = asAnswer(data);
    // An unreadable frame, or an answer to a call nobody is waiting for (a
    // duplicate, or one that lost a race with a reload). Neither is worth
    // breaking a working extension over.
    if (!msg) return;
    const waiting = this.#waiting.get(msg.id);
    if (!waiting) return;
    this.#waiting.delete(msg.id);
    if (msg.ok) waiting.resolve(msg.result);
    else waiting.reject(new PewtError(msg.error));
  }
}

/** The typed API over a channel. Namespaces are spelled out for the same
 *  reason `PewtApi` is: an editor completes what it can see. */
export function apiFor(channel: Channel): PewtApi {
  return {
    repos: {
      list: () => channel.call("repos.list") as Promise<{ repos: Project[] }>,
      create: (params) => channel.call("repos.create", params) as Promise<{ repo: Project }>,
      // A clone is `run`'s shape with a different child: the call stays open
      // while git works, its output arrives as events on the same id, and the
      // answer is the exit code.
      clone: (url, options = {}) => {
        const { onOutput } = options;
        return channel.call(
          "repos.clone",
          { url, ...(options.name !== undefined ? { name: options.name } : {}) },
          onOutput &&
            ((event: unknown) => {
              const line = event as { o?: unknown; e?: unknown };
              if (typeof line.o === "string") onOutput(line.o, "out");
              else if (typeof line.e === "string") onOutput(line.e, "err");
            })
        ) as Promise<CloneResult>;
      },
    },
    ext: {
      bundle: (params) => channel.call("ext.bundle", params) as Promise<Bundle>,
    },
    run: (script, options = {}) => {
      const { onOutput } = options;
      return channel.call(
        "run",
        { script, ...(options.repo !== undefined ? { repo: options.repo } : {}) },
        onOutput &&
          ((event: unknown) => {
            // The host's own frames, unchanged all the way from the child's
            // stdout (packages/pewt/src/run.ts). Read here rather than
            // translated somewhere in between, so there is one reader.
            const line = event as { o?: unknown; e?: unknown };
            if (typeof line.o === "string") onOutput(line.o, "out");
            else if (typeof line.e === "string") onOutput(line.e, "err");
          })
      ) as Promise<RunResult>;
    },
    shell: (options = {}) => {
      // Two promises, because a shell has two moments worth waiting for.
      // `answer` is the call itself and settles when the shell exits;
      // `running` settles when it started, which is what `pewt.shell()`
      // resolves to. The gap between them is a human deciding.
      let started: ((shell: Shell) => void) | null = null;
      let failed: ((e: Error) => void) | null = null;
      const running = new Promise<Shell>((resolve, reject) => {
        started = resolve;
        failed = reject;
      });

      const { id, answer } = channel.open("shell", shellSpec(options), (payload) => {
        const e = payload as { d?: unknown; started?: unknown };
        if (typeof e.d === "string") options.onData?.(e.d);
        else if (e.started) started?.(shell);
      });

      const shell: Shell = {
        write: (data) => channel.send(id, { d: data }),
        resize: (cols, rows) => channel.send(id, { cols, rows }),
        close: () => channel.send(id, { close: true }),
        // Resolves either way: a shell that never started reports the
        // refusal through `running`, and a caller holding the handle for the
        // exit code should not also have to catch it there.
        exit: new Promise<number | null>((resolve) => {
          answer.then(
            (result) => resolve((result as ShellResult).exitCode),
            () => resolve(null)
          );
        }),
      };
      answer.catch((e: unknown) => failed?.(e instanceof Error ? e : new Error(String(e))));
      return running;
    },
    agents: {
      list: () => channel.call("agents.list") as Promise<{ agents: AgentEntry[] }>,
    },
    agent: (options = {}) => {
      // The same two-promise shape a shell has, and for the same reason: the
      // call settles when the agent exits, and `pewt.agent()` settles when it
      // started. The gap between them is a human deciding.
      let started: ((agent: Agent) => void) | null = null;
      let failed: ((e: Error) => void) | null = null;
      const running = new Promise<Agent>((resolve, reject) => {
        started = resolve;
        failed = reject;
      });

      const { id, answer } = channel.open("agent", agentSpec(options), (payload) => {
        const e = payload as { m?: unknown; started?: unknown };
        if (e.started) started?.(agent);
        else if ("m" in e) options.onMessage?.(e.m);
      });

      const agent: Agent = {
        send: (message) => channel.send(id, { m: message }),
        close: () => channel.send(id, { close: true }),
        exit: new Promise<number | null>((resolve) => {
          answer.then(
            (result) => resolve((result as { exitCode: number | null }).exitCode),
            () => resolve(null)
          );
        }),
      };
      answer.catch((e: unknown) => failed?.(e instanceof Error ? e : new Error(String(e))));
      return running;
    },
    grants: {
      list: () => channel.call("grants.list") as Promise<{ grants: Grant[] }>,
      revoke: (params) => channel.call("grants.revoke", params) as Promise<{ id: string; grant: Grant }>,
    },
    // The page's own, and they go over the same channel as everything else:
    // the shell answers these itself instead of forwarding them to the host,
    // and an extension is not told which it got. What that buys is a tab
    // operation costing one message rather than a round trip through the
    // folder — and, more to the point, working at all, since the answer is in
    // the shell and nowhere else.
    tabs: {
      list: () => channel.call("tabs.list") as Promise<TabsListing>,
      add: (params) => channel.call("tabs.add", params) as Promise<{ id: string; name: string; title: string; active: boolean }>,
      update: (params) => channel.call("tabs.update", params) as Promise<{ id: string; title: string }>,
      close: (params) => channel.call("tabs.close", params) as Promise<{ id: string; activeId: string | null }>,
      focus: (params) => channel.call("tabs.focus", params) as Promise<{ id: string; title: string }>,
    },
    // The path is the first argument rather than a field, because it is the
    // whole of what these two commands are about and `pewt.open({ path })`
    // would be ceremony. What travels is the same object either way.
    open: (path, options = {}) => channel.call("files.open", { path, ...options }) as Promise<OpenResult>,
    fling: (path, options = {}) => channel.call("files.fling", { path, ...options }) as Promise<FlingResult>,
    files: {
      list: () => channel.call("files.list") as Promise<{ files: HeldFile[] }>,
      show: (params) => channel.call("files.show", params) as Promise<{ id: string; fileId: string; name: string; active: boolean; reused: boolean }>,
      drop: (params) => channel.call("files.drop", params) as Promise<{ id: string; name: string; closedTabs: number; activeId: string | null }>,
    },
  };
}

/** Re-exported so an extension can type what `tabs.list()` and `files.list()`
 *  give it without reaching past the API for them. */
export type { HeldFile, Tab, TabsListing, TabsState };
