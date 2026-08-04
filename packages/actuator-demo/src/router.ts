// The switchboard: one page on one side, any number of short-lived CLI
// sessions on the other, and the correlation between a command and its
// receipt in the middle.
//
// Deliberately knows nothing about fsio. It takes a "page port" (something
// that can be sent a message) and hands back promises, so the whole routing
// story is testable without a host, a folder, or a browser. kinds.ts is the
// thin part that makes the two real session kinds satisfy it.
import { AppError, type Operation } from "./model.js";
import type { Downstream, Upstream } from "./messages.js";
import { command } from "./messages.js";

/** Whatever can be handed a message for the page. In the helper this is a
 *  session's `ctx.write`; in tests it is a function pushing onto an array. */
export interface PagePort {
  /** the session id — what "newest wins" is decided on, and what the logs
   *  name when a page is displaced. */
  readonly id: string;
  send(msg: Downstream): void;
}

/** Why a command never got an answer. Distinct from AppError, which is the
 *  page answering "no": these are the ways the channel itself failed. */
export class ChannelError extends Error {
  constructor(
    readonly reason: "no_page" | "page_gone" | "timeout",
    message: string
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long the helper holds a command open before giving up on the page.
 *  The CLI has its own, shorter deadline; this one only exists so a page
 *  that goes quiet cannot leak pending entries into a long-lived helper. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class Router {
  #page: PagePort | null = null;
  #pending = new Map<string, Pending>();
  #seq = 0;

  get pageId(): string | null {
    return this.#page?.id ?? null;
  }

  get attached(): boolean {
    return this.#page !== null;
  }

  /** Newest page wins. The displaced one is told — it is still a live
   *  session holding a working app, it just is not the one being driven,
   *  and a page that silently stops responding to a CLI is the worst
   *  version of this. */
  attachPage(port: PagePort): { displaced: string | null } {
    const old = this.#page;
    this.#page = port;
    if (old && old.id !== port.id) {
      old.send({ v: 1, type: "displaced" });
      this.#failAll(new ChannelError("page_gone", `page ${old.id} was displaced by ${port.id}`));
      return { displaced: old.id };
    }
    return { displaced: null };
  }

  /** Only the current page detaching means anything; a displaced page
   *  closing later must not clear its successor. */
  detachPage(id: string): boolean {
    if (this.#page?.id !== id) return false;
    this.#page = null;
    this.#failAll(new ChannelError("page_gone", "the page closed before answering"));
    return true;
  }

  /** Send one operation to the page and wait for its receipt.
   *
   *  Rejects with ChannelError when the channel failed and with AppError
   *  when the page refused — the CLI reports those differently, because
   *  "no page is open" and "no such tab" are different things to do next. */
  dispatch(op: Operation, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const page = this.#page;
    if (!page) {
      return Promise.reject(new ChannelError("no_page", "no page is attached to this folder"));
    }
    const id = `c${(++this.#seq).toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ChannelError("timeout", `the page did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        page.send(command(id, op));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ChannelError("page_gone", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** A receipt arrived from the page. Returns false for a receipt nobody
   *  is waiting on (a duplicate, or one that beat a timeout) — legal, and
   *  worth a log line, never an error. */
  receipt(msg: Upstream): boolean {
    const pending = this.#pending.get(msg.id);
    if (!pending) return false;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new AppError(msg.error.code, msg.error.message, msg.error.hint));
    return true;
  }

  /** Helper shutdown: nothing is going to be answered now. */
  close(): void {
    this.#page = null;
    this.#failAll(new ChannelError("page_gone", "the helper is shutting down"));
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }
}
