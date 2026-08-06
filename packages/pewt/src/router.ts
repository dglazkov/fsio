// The switchboard: one page on one side, every other client on the other, and
// the correlation between a command and its receipt in the middle.
//
// Pewter's operations split by who answers them. `repos`, `ext`, `run`,
// `shell` and `agent` are the host's, because the answer is on the machine.
// `tabs` is the page's, because a tab is not on disk anywhere — it exists
// because a browser is open. Until now every operation was the first kind and
// the host could answer everything by itself; this is what changes with the
// second kind, and it is the piece NARRATIVE.md never spells out.
//
// Deliberately knows nothing about fsio. It takes a "page port" — something
// that can be sent a command — and hands back promises, so the routing is
// testable without a host, a folder, or a browser. kind.ts is the thin part
// that makes the real session satisfy it. That shape is `actuator-demo`'s
// (src/router.ts), harvested rather than reinvented: it is the same problem
// with the same answer, and the demo it came from is still running.
import { command, type Receipt } from "pewter";

/** Whatever can be handed a command for the page. In the host this is a
 *  session's `ctx.write`; in tests it is a function pushing onto an array. */
export interface PagePort {
  /** the session id — what "newest wins" is decided on, and what a log line
   *  names when a page is displaced. */
  readonly id: string;
  send(msg: ReturnType<typeof command>): void;
}

/** Why a command never got an answer. Distinct from the page refusing: these
 *  are the ways the channel itself failed, and they are what the narrative's
 *  exit 4 is about — "no host" and "no page" need different fixes. */
export class PageError extends Error {
  constructor(
    readonly reason: "no_page" | "page_gone" | "timeout",
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "PageError";
  }
}

/** The page said no. The command arrived, the page understood it, and the
 *  answer was no — `no tab with id "tab-9f"` is this, and it travels with the
 *  page's own code and hint rather than being summarized into a sentence. */
export class PageRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "PageRefusal";
  }
}

/** How long the host holds a command open before giving up on the page.
 *
 *  Generous next to a p50 5.3 ms browser round trip (F3). What it covers is a
 *  page in a background tab, clamped to about one timer a minute (F16) — and
 *  it does not cover it: a hidden tab can miss this deadline and the command
 *  is not lost, it is only stopped being waited for. That collision is
 *  [#144](https://github.com/dglazkov/fsio/issues/144) and it is named in
 *  https://github.com/dglazkov/fsio/issues/164's strain list rather than
 *  solved here; what this number buys is that the failure says "the page did
 *  not answer" instead of hanging. */
export const COMMAND_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Router {
  #page: PagePort | null = null;
  #pending = new Map<string, Pending>();
  #seq = 0;

  get pageId(): string | null {
    return this.#page?.id ?? null;
  }

  /** Whether a page is listening. The `pewt` session's spawn result carries
   *  this, so a command line learns there is nobody to ask before it asks. */
  get attached(): boolean {
    return this.#page !== null;
  }

  /** Newest page wins. A pewter is one folder and one shell; a second page on
   *  the same folder is usually the first one reloaded, and the displaced
   *  session is about to close anyway. The commands waiting on it fail now
   *  rather than at their timeout, because the party that was going to answer
   *  them is gone. */
  attachPage(port: PagePort): { displaced: string | null } {
    const old = this.#page;
    this.#page = port;
    if (old && old.id !== port.id) {
      this.#failAll(new PageError("page_gone", `page ${old.id} was displaced by ${port.id}`));
      return { displaced: old.id };
    }
    return { displaced: null };
  }

  /** Only the current page detaching means anything; a displaced page closing
   *  later must not clear its successor. */
  detachPage(id: string): boolean {
    if (this.#page?.id !== id) return false;
    this.#page = null;
    this.#failAll(new PageError("page_gone", "the page closed before answering"));
    return true;
  }

  /** Send one command to the page and wait for its receipt.
   *
   *  Rejects with PageError when the channel failed and with PageRefusal when
   *  the page said no. A caller reports those differently: one is "open the
   *  page", the other is "that tab does not exist". */
  dispatch(method: string, params: unknown, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const page = this.#page;
    if (!page) {
      return Promise.reject(
        new PageError("no_page", "no page is open on this pewter", "open the shell in a Chromium browser, drop this folder on it, and allow it")
      );
    }
    const id = `c${(++this.#seq).toString(36)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new PageError(
            "timeout",
            `the page did not answer within ${timeoutMs}ms`,
            // Both readings are live and nothing here can tell them apart: a
            // page that died without closing its session still looks attached,
            // and a page in a background tab is genuinely just slow (F16).
            "the tab may be in the background — browsers clamp those to about one timer a minute — or it may have gone without closing its session"
          )
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        page.send(command(id, method, params));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new PageError("page_gone", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** A receipt arrived from the page. Returns false for one nobody is waiting
   *  on — a duplicate, or one that beat a timeout. Legal, and worth a log
   *  line, never an error. */
  receipt(msg: Receipt): boolean {
    const pending = this.#pending.get(msg.id);
    if (!pending) return false;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new PageRefusal(msg.error.code, msg.error.message, msg.error.hint));
    return true;
  }

  /** Host shutdown: nothing is going to be answered now. */
  close(): void {
    this.#page = null;
    this.#failAll(new PageError("page_gone", "the host is shutting down"));
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }
}
