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
import { asAnswer, WIRE_VERSION, type ApiError, type Call } from "./wire.js";

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
export interface PewtApi {
  repos: {
    /** Every project in this pewter, by name. */
    list(): Promise<{ repos: Project[] }>;
  };
  ext: {
    /** Build an extension into one self-contained HTML file. The shell calls
     *  this to open a tab; an extension calls it to rebuild a sibling. */
    bundle(params: { name: string }): Promise<Bundle>;
  };
}

/** Every method this package knows how to spell, in wire form. The host's
 *  table is the authority; this is the list that gets checked against it. */
export const METHODS = ["repos.list", "ext.bundle"] as const;

/** The extension's end of the channel. One per extension, made by
 *  `connectTo` and used by `pewt`. */
export class Channel {
  #port: MessagePort | null = null;
  #next = 1;
  readonly #waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Calls made before the port arrived. An extension's first render happens
   *  in the same tick as its script runs, and the port is one message later;
   *  losing those calls would make every extension start with a race. */
  readonly #queued: Call[] = [];

  attach(port: MessagePort): void {
    if (this.#port) throw new Error("this channel already has a port");
    this.#port = port;
    port.onmessage = (event: MessageEvent) => this.#onAnswer(event.data);
    port.start();
    for (const call of this.#queued.splice(0)) port.postMessage(call);
  }

  get attached(): boolean {
    return this.#port !== null;
  }

  call(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.#next++;
    const message: Call = { v: WIRE_VERSION, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      if (this.#port) this.#port.postMessage(message);
      else this.#queued.push(message);
    });
  }

  #onAnswer(data: unknown): void {
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
    },
    ext: {
      bundle: (params) => channel.call("ext.bundle", params) as Promise<Bundle>,
    },
  };
}
