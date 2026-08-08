import { type Agent, type AgentEntry, type AgentOptions } from "./agent.js";
import type { HeldFile } from "./files.js";
import type { Grant } from "./grants.js";
import { type Shell, type ShellOptions } from "./shell.js";
import { type Tab, type TabsListing, type TabsState } from "./tabs.js";
import { type ApiError } from "./wire.js";
/** A project in this pewter — a directory under `repos/`. */
export interface Project {
    name: string;
    /** whether it is a git repository. A directory that is not one is still
     *  listed: the folder is the user's, and hiding what is in it would be a
     *  lie about their own disk. */
    git: boolean;
    /** the branch it is on, or null — detached, or not a repository. */
    branch: string | null;
    /** the script names its `package.json` declares, in declaration order.
     *  These are what `pewt.run(name, { repo })` can start — the set of
     *  runnable things is a file, and this is that file's table of contents. */
    scripts: string[];
    /** null: no manifest, nothing to install. false: a manifest and no
     *  `node_modules` — every fresh clone, and the state the install verb is
     *  for. true: `node_modules` exists (a directory read, not a lockfile
     *  comparison). */
    installed: boolean | null;
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
/** One screen this pewter holds, built or not.
 *
 *  `ready` is false for a directory under `extensions/` that is missing an
 *  `index.html` or a `main.ts` — the normal state of a screen somebody is in
 *  the middle of writing. Listed rather than hidden, so what the page offers
 *  agrees with what the folder contains. */
export interface Extension {
    name: string;
    ready: boolean;
    missing?: string;
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
/** What an exec does while it runs. The same stream a run has: whole lines,
 *  in order, with stderr kept apart. */
export interface ExecOptions {
    /** a project under `repos/`. Omit it to run in the pewter itself. */
    repo?: string;
    onOutput?: (line: string, stream: "out" | "err") => void;
}
/** A finished exec. 127 is this host's answer for a program that is not on
 *  the machine — the reason arrives on `onOutput` in words first. */
export interface ExecResult {
    exitCode: number | null;
}
/** The operation said no. Thrown rather than returned, because
 *  `await pewt.repos.list()` should read like every other call an extension
 *  makes — and because an error that has to be checked for is an error that
 *  gets ignored. */
export declare class PewtError extends Error {
    readonly code: string;
    readonly hint?: string;
    constructor(error: ApiError);
}
/** A refusal in words a screen can show: the message, and the hint on its
 *  own line when the operation sent one. Extracted from the scaffolded
 *  extensions, each of which had written exactly this — it lives here rather
 *  than in a UI package because it is about this package's error shape, not
 *  about how anything looks. */
export declare function explain(e: unknown): string;
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
/** What an install does while it runs. Same stream as a clone's. */
export interface InstallOptions {
    onOutput?: (line: string, stream: "out" | "err") => void;
}
export interface PewtApi {
    repos: {
        /** Every project in this pewter, by name. */
        list(): Promise<{
            repos: Project[];
        }>;
        /** Start a new project: a directory under `repos/`, `git init` run in
         *  it, nothing else. Refused if the name is taken. Asks nobody — it is a
         *  mkdir in the folder this page was already granted. */
        create(params: {
            name: string;
        }): Promise<{
            repo: Project;
        }>;
        /** Clone a repository into `repos/`, streaming git's own output.
         *
         *  Resolves when git exits. Asks nobody (#189): git fetches and executes
         *  nothing it fetched. A url that needs credentials fails rather than
         *  prompts — the host runs git with no terminal to ask on — and the
         *  failure arrives in git's own words through `onOutput`. */
        clone(url: string, options?: CloneOptions): Promise<CloneResult>;
        /** `npm install` in a project — the half of clone that IS asked (#193).
         *
         *  Install is the first execution of what a clone fetched: lifecycle
         *  scripts run, so the host asks a human at its own terminal first. The
         *  question rides the run rung — `--allow-runs` and a standing
         *  `run/<project>` grant both cover it — and this call can wait as long
         *  as a human takes, and can come back refused. */
        install(name: string, options?: InstallOptions): Promise<CloneResult>;
    };
    ext: {
        /** What `extensions/` holds — every screen this pewter can open, whether
         *  or not it is finished. The folder is the list and nothing caches it,
         *  so a screen written a moment ago is on the next answer. */
        list(): Promise<{
            extensions: Extension[];
        }>;
        /** Build an extension into one self-contained HTML file. The shell calls
         *  this to open a tab; an extension calls it to rebuild a sibling. */
        bundle(params: {
            name: string;
        }): Promise<Bundle>;
    };
    /** Run a script the project already declares.
     *
     *  An extension cannot invent one: the name has to be in a `package.json`
     *  you can read, so the set of runnable things is a file rather than a
     *  capability this API grants. The host asks a human before it starts
     *  anything, so this call can wait a while and can come back refused. */
    run(script: string, options?: RunOptions): Promise<RunResult>;
    /** Run a program and read what it printed.
     *
     *  The program and its arguments are separate strings and reach the OS that
     *  way: there is no shell, so nothing is quoted, expanded, or split, and no
     *  rc file runs. There is no terminal either — output is stdout and stderr,
     *  kept apart, arriving as whole lines, and the call answers with the exit
     *  code. A pipeline belongs on this side: `git log --format=%cd` and a
     *  `reduce` rather than `| sort | uniq -c`.
     *
     *  This is `run`'s sibling and its opposite: `run` can only start what a
     *  project already declares, and this can start anything on the machine. The
     *  host asks a human at its own terminal first, so it can wait a while and
     *  can come back refused. */
    exec(cmd: string, args?: string[], options?: ExecOptions): Promise<ExecResult>;
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
        list(): Promise<{
            agents: AgentEntry[];
        }>;
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
        list(): Promise<{
            grants: Grant[];
        }>;
        /** Take one back, so the next one asks again.
         *
         *  There is no `add` here and there will not be. A grant is made by a
         *  human typing at the host's terminal and by nothing else (P5), so the
         *  only direction this API moves is narrower. */
        revoke(params: {
            id: string;
        }): Promise<{
            id: string;
            grant: Grant;
        }>;
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
         *  wrong without opening the tab it asked for.
         *
         *  `args` is delivered to the opened extension (`import { args } from
         *  "pewter"`), uninterpreted: what it means is between the sender and
         *  the screen it opened. The repos row's shell verb is the worked
         *  example — `{ name: "terminal", args: { repo } }`. */
        add(params: {
            name: string;
            title?: string;
            activate?: boolean;
            args?: unknown;
        }): Promise<{
            id: string;
            name: string;
            title: string;
            active: boolean;
        }>;
        /** Rename one. The extension in it does not care and is not told. */
        update(params: {
            id: string;
            title: string;
        }): Promise<{
            id: string;
            title: string;
        }>;
        /** Close one. Whatever the extension in it was doing stops with it. */
        close(params: {
            id: string;
        }): Promise<{
            id: string;
            activeId: string | null;
        }>;
        /** Bring one forward. */
        focus(params: {
            id: string;
        }): Promise<{
            id: string;
            title: string;
        }>;
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
        list(): Promise<{
            files: HeldFile[];
        }>;
        /** Put a copy back in a tab. */
        show(params: {
            id: string;
            title?: string;
            activate?: boolean;
        }): Promise<{
            id: string;
            fileId: string;
            name: string;
            active: boolean;
            reused: boolean;
        }>;
        /** Forget a copy and free its bytes. Tabs showing it close with it. */
        drop(params: {
            id: string;
        }): Promise<{
            id: string;
            name: string;
            closedTabs: number;
            activeId: string | null;
        }>;
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
export declare const METHODS: readonly ["repos.list", "repos.create", "repos.clone", "repos.install", "ext.list", "ext.bundle", "agents.list", "grants.list", "grants.revoke", "run", "exec", "shell", "agent", ...("files.drop" | "files.fling" | "files.list" | "files.open" | "files.show" | "tabs.add" | "tabs.close" | "tabs.focus" | "tabs.list" | "tabs.update")[]];
/** The extension's end of the channel. One per extension, made by
 *  `connectTo` and used by `pewt`. */
export declare class Channel {
    #private;
    attach(port: MessagePort): void;
    get attached(): boolean;
    /** Make a call. `onEvent` receives whatever arrives while it is still
     *  running — nothing at all for an operation that just answers. The
     *  callback stays in this frame; only its call's id crosses the channel. */
    call(method: string, params?: unknown, onEvent?: (event: unknown) => void): Promise<unknown>;
    /** Make a call and keep its number, so more can be sent to it while it
     *  runs. `call` is this with the number thrown away, which is the right
     *  shape for every operation that answers once. */
    open(method: string, params?: unknown, onEvent?: (event: unknown) => void): {
        id: number;
        answer: Promise<unknown>;
    };
    /** Say that this frame broke, out loud, where the folder can carry it.
     *
     *  Queued like anything else when the port has not landed — a screen that
     *  throws on its first line throws before the handshake, and that is the
     *  report most worth having. */
    trouble(kind: "error" | "rejection", message: string, stack?: string, at?: string): void;
    /** Send more to a call already in flight — a keystroke, a window size, a
     *  request to stop. Nothing comes back: what a shell has to say arrives as
     *  events on the call it belongs to. */
    send(id: number, body: unknown): void;
}
/** The typed API over a channel. Namespaces are spelled out for the same
 *  reason `PewtApi` is: an editor completes what it can see. */
export declare function apiFor(channel: Channel): PewtApi;
/** Re-exported so an extension can type what `tabs.list()` and `files.list()`
 *  give it without reaching past the API for them. */
export type { HeldFile, Tab, TabsListing, TabsState };
//# sourceMappingURL=api.d.ts.map