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
import { agentSpec } from "./agent.js";
import { shellSpec } from "./shell.js";
import { PAGE_METHODS } from "./tabs.js";
import { asAnswer, asEvent, send, WIRE_VERSION } from "./wire.js";
/** The operation said no. Thrown rather than returned, because
 *  `await pewt.repos.list()` should read like every other call an extension
 *  makes — and because an error that has to be checked for is an error that
 *  gets ignored. */
export class PewtError extends Error {
    code;
    hint;
    constructor(error) {
        super(error.message);
        this.name = "PewtError";
        this.code = error.code;
        if (error.hint !== undefined)
            this.hint = error.hint;
    }
}
/** Every method this package knows how to spell, in wire form. The host's
 *  table is the authority; this is the list that gets checked against it.
 *
 *  The page's own methods are in it too, and an extension cannot tell them
 *  apart — which is the claim: one API, and where an operation is answered is
 *  the implementation's business rather than the caller's. */
export const METHODS = ["repos.list", "repos.create", "repos.clone", "repos.install", "ext.bundle", "agents.list", "grants.list", "grants.revoke", "run", "shell", "agent", ...PAGE_METHODS];
/** The extension's end of the channel. One per extension, made by
 *  `connectTo` and used by `pewt`. */
export class Channel {
    #port = null;
    #next = 1;
    #waiting = new Map();
    /** Messages made before the port arrived, in order. An extension's first
     *  render happens in the same tick as its script runs, and the port is one
     *  message later; losing those calls would make every extension start with
     *  a race. Order is what makes it safe to queue a send behind its call. */
    #queued = [];
    attach(port) {
        if (this.#port)
            throw new Error("this channel already has a port");
        this.#port = port;
        port.onmessage = (event) => this.#onMessage(event.data);
        port.start();
        for (const message of this.#queued.splice(0))
            port.postMessage(message);
    }
    get attached() {
        return this.#port !== null;
    }
    /** Make a call. `onEvent` receives whatever arrives while it is still
     *  running — nothing at all for an operation that just answers. The
     *  callback stays in this frame; only its call's id crosses the channel. */
    call(method, params = {}, onEvent) {
        return this.open(method, params, onEvent).answer;
    }
    /** Make a call and keep its number, so more can be sent to it while it
     *  runs. `call` is this with the number thrown away, which is the right
     *  shape for every operation that answers once. */
    open(method, params = {}, onEvent) {
        const id = this.#next++;
        const message = { v: WIRE_VERSION, id, method, params };
        const answer = new Promise((resolve, reject) => {
            this.#waiting.set(id, { resolve, reject, ...(onEvent ? { onEvent } : {}) });
            this.#post(message);
        });
        return { id, answer };
    }
    /** Send more to a call already in flight — a keystroke, a window size, a
     *  request to stop. Nothing comes back: what a shell has to say arrives as
     *  events on the call it belongs to. */
    send(id, body) {
        // A send to a call that is already over is dropped here rather than at
        // the far end. The typical one is a keystroke racing the exit, and
        // waking the shell to be told about it helps nobody.
        if (!this.#waiting.has(id))
            return;
        this.#post(send(id, body));
    }
    #post(message) {
        if (this.#port)
            this.#port.postMessage(message);
        else
            this.#queued.push(message);
    }
    #onMessage(data) {
        const event = asEvent(data);
        if (event) {
            // An event for a call that already ended, or one nobody is listening
            // for. Dropped: an event is news about a call, and a call that is over
            // has no news left worth throwing over.
            const waiting = this.#waiting.get(event.id);
            try {
                waiting?.onEvent?.(event.event);
            }
            catch {
                // The extension's own callback threw. That is its bug and its tab;
                // it must not take the run's answer down with it.
            }
            return;
        }
        const msg = asAnswer(data);
        // An unreadable frame, or an answer to a call nobody is waiting for (a
        // duplicate, or one that lost a race with a reload). Neither is worth
        // breaking a working extension over.
        if (!msg)
            return;
        const waiting = this.#waiting.get(msg.id);
        if (!waiting)
            return;
        this.#waiting.delete(msg.id);
        if (msg.ok)
            waiting.resolve(msg.result);
        else
            waiting.reject(new PewtError(msg.error));
    }
}
/** The typed API over a channel. Namespaces are spelled out for the same
 *  reason `PewtApi` is: an editor completes what it can see. */
export function apiFor(channel) {
    return {
        repos: {
            list: () => channel.call("repos.list"),
            create: (params) => channel.call("repos.create", params),
            // A clone is `run`'s shape with a different child: the call stays open
            // while git works, its output arrives as events on the same id, and the
            // answer is the exit code.
            clone: (url, options = {}) => {
                const { onOutput } = options;
                return channel.call("repos.clone", { url, ...(options.name !== undefined ? { name: options.name } : {}) }, onOutput &&
                    ((event) => {
                        const line = event;
                        if (typeof line.o === "string")
                            onOutput(line.o, "out");
                        else if (typeof line.e === "string")
                            onOutput(line.e, "err");
                    }));
            },
            install: (name, options = {}) => {
                const { onOutput } = options;
                return channel.call("repos.install", { name }, onOutput &&
                    ((event) => {
                        const line = event;
                        if (typeof line.o === "string")
                            onOutput(line.o, "out");
                        else if (typeof line.e === "string")
                            onOutput(line.e, "err");
                    }));
            },
        },
        ext: {
            bundle: (params) => channel.call("ext.bundle", params),
        },
        run: (script, options = {}) => {
            const { onOutput } = options;
            return channel.call("run", { script, ...(options.repo !== undefined ? { repo: options.repo } : {}) }, onOutput &&
                ((event) => {
                    // The host's own frames, unchanged all the way from the child's
                    // stdout (packages/pewt/src/run.ts). Read here rather than
                    // translated somewhere in between, so there is one reader.
                    const line = event;
                    if (typeof line.o === "string")
                        onOutput(line.o, "out");
                    else if (typeof line.e === "string")
                        onOutput(line.e, "err");
                }));
        },
        shell: (options = {}) => {
            // Two promises, because a shell has two moments worth waiting for.
            // `answer` is the call itself and settles when the shell exits;
            // `running` settles when it started, which is what `pewt.shell()`
            // resolves to. The gap between them is a human deciding.
            let started = null;
            let failed = null;
            const running = new Promise((resolve, reject) => {
                started = resolve;
                failed = reject;
            });
            const { id, answer } = channel.open("shell", shellSpec(options), (payload) => {
                const e = payload;
                if (typeof e.d === "string")
                    options.onData?.(e.d);
                else if (e.started)
                    started?.(shell);
            });
            const shell = {
                write: (data) => channel.send(id, { d: data }),
                resize: (cols, rows) => channel.send(id, { cols, rows }),
                close: () => channel.send(id, { close: true }),
                // Resolves either way: a shell that never started reports the
                // refusal through `running`, and a caller holding the handle for the
                // exit code should not also have to catch it there.
                exit: new Promise((resolve) => {
                    answer.then((result) => resolve(result.exitCode), () => resolve(null));
                }),
            };
            answer.catch((e) => failed?.(e instanceof Error ? e : new Error(String(e))));
            return running;
        },
        agents: {
            list: () => channel.call("agents.list"),
        },
        agent: (options = {}) => {
            // The same two-promise shape a shell has, and for the same reason: the
            // call settles when the agent exits, and `pewt.agent()` settles when it
            // started. The gap between them is a human deciding.
            let started = null;
            let failed = null;
            const running = new Promise((resolve, reject) => {
                started = resolve;
                failed = reject;
            });
            const { id, answer } = channel.open("agent", agentSpec(options), (payload) => {
                const e = payload;
                if (e.started)
                    started?.(agent);
                else if ("m" in e)
                    options.onMessage?.(e.m);
            });
            const agent = {
                send: (message) => channel.send(id, { m: message }),
                close: () => channel.send(id, { close: true }),
                exit: new Promise((resolve) => {
                    answer.then((result) => resolve(result.exitCode), () => resolve(null));
                }),
            };
            answer.catch((e) => failed?.(e instanceof Error ? e : new Error(String(e))));
            return running;
        },
        grants: {
            list: () => channel.call("grants.list"),
            revoke: (params) => channel.call("grants.revoke", params),
        },
        // The page's own, and they go over the same channel as everything else:
        // the shell answers these itself instead of forwarding them to the host,
        // and an extension is not told which it got. What that buys is a tab
        // operation costing one message rather than a round trip through the
        // folder — and, more to the point, working at all, since the answer is in
        // the shell and nowhere else.
        tabs: {
            list: () => channel.call("tabs.list"),
            add: (params) => channel.call("tabs.add", params),
            update: (params) => channel.call("tabs.update", params),
            close: (params) => channel.call("tabs.close", params),
            focus: (params) => channel.call("tabs.focus", params),
        },
        // The path is the first argument rather than a field, because it is the
        // whole of what these two commands are about and `pewt.open({ path })`
        // would be ceremony. What travels is the same object either way.
        open: (path, options = {}) => channel.call("files.open", { path, ...options }),
        fling: (path, options = {}) => channel.call("files.fling", { path, ...options }),
        files: {
            list: () => channel.call("files.list"),
            show: (params) => channel.call("files.show", params),
            drop: (params) => channel.call("files.drop", params),
        },
    };
}
//# sourceMappingURL=api.js.map