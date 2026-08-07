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
    asks: boolean;
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
    asks: boolean;
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
export declare function agentSpec(options?: AgentOptions): {
    agent?: string;
    repo?: string;
};
//# sourceMappingURL=agent.d.ts.map