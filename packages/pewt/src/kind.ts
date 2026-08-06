// The `pewt` session kind: the host's half of the API, and the page's.
//
// A kind is "a set of RPC methods plus a DATA sink/source — bring your own
// semantics" (D13). This one was all methods and no data until the page got
// operations of its own; now both halves are used, and in opposite
// directions:
//
//   methods  client → host. Every operation in the table, whoever answers it.
//   DATA     host → page, and back. A command the page answers, and its
//            receipt (packages/pewter/src/control.ts).
//
// Every client opens this same kind, and the shell is the one that says
// `page: true` in its spec. That flag is what makes it the party commands are
// delivered to — a session, not a second kind, because the page's control
// session already exists and giving it a second one would double what a folder
// holds for nothing.
//
// Both front ends open this kind. `pewt repos` in a terminal and
// `pewt.repos.list()` in an extension are the same session, the same method,
// and the same table — which is what stops the two surfaces from drifting.
import { RpcError, RpcErrors } from "@fsio/common";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { asReceipt, encodeControl } from "pewter";
import { hostAnswers, OPERATIONS, OpError } from "./ops.js";
import type { Pewter } from "./pewter.js";
import { PageError, PageRefusal, type Router } from "./router.js";

export function pewtKind(p: Pewter, router: Router, log: HostLogger): KindHandler {
  const methods: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const op of OPERATIONS) {
    methods[op.method] = async (params: unknown) => {
      try {
        // The one line where the two answerers differ. Everything else about
        // an operation — its spellings, its parameter check, what a terminal
        // prints — is the same whether the answer is on this machine or in a
        // browser tab.
        const checked = op.parse(params);
        const result = hostAnswers(op) ? await op.run!(p, checked) : await router.dispatch(op.method, checked);
        log.info(`${op.method} → ok`);
        return result;
      } catch (e) {
        throw asRpcError(e, op.method, log);
      }
    };
  }

  return (ctx: KindContext): KindSession => {
    const isPage = ctx.spec["page"] === true;
    if (!isPage) {
      log.info(`● client attached (${ctx.sessionId}) — ${String(ctx.spec["client"] ?? "unnamed")}`);
      return { result: spawnResult(), methods, onClose: () => log.info(`○ client detached (${ctx.sessionId})`) };
    }

    const { displaced } = router.attachPage({ id: ctx.sessionId, send: (msg) => ctx.write(encodeControl(msg)) });
    if (displaced) log.warn(`page ${ctx.sessionId} took over from ${displaced}`);
    log.info(`● page attached (${ctx.sessionId}) — tab commands will be delivered here`);
    return {
      result: { ...spawnResult(), page: true, displaced },
      methods,
      onData: (bytes) => {
        const msg = asReceipt(bytes);
        if (!msg) return void log.warn("dropped an unreadable frame from the page");
        // A receipt nobody awaits is legal — a duplicate, or one that lost a
        // race with a timeout. Log it and carry on.
        if (!router.receipt(msg)) log.warn(`receipt ${msg.id} matched no waiting command`);
      },
      onClose: () => {
        if (router.detachPage(ctx.sessionId)) log.info(`○ page detached (${ctx.sessionId})`);
      },
    };
  };

  /** What a client learns on connect.
   *
   *  The operation list is here because the shell ships on our schedule and
   *  `pewt` is installed on yours: the two can disagree about the API, and a
   *  client that can see what this host actually serves can say so plainly
   *  instead of failing at the call. Noticing that disagreement is not built
   *  yet (https://github.com/dglazkov/fsio/issues/164) — this is the fact it
   *  will need.
   *
   *  `page` says whether anybody is there to answer the page's operations. It
   *  is read at spawn rather than at the call because a kind handler cannot
   *  raise a code of its own — @fsio/host flattens a handler throw to `1002
   *  spawn-failed` — so the fact goes in the result, where D13 allows it. A
   *  command line still learns "no page" from the refusal below; this is what
   *  lets one say so before it asks. */
  function spawnResult(): Record<string, unknown> {
    return { pewter: p.name, operations: OPERATIONS.map((o) => o.method), page: router.attached };
  }
}

/** An operation's refusal, or a page's, as a JSON-RPC error.
 *
 *  None of these is one of the protocol's numbered failures, and taking a
 *  number out of the 1001–1007 range for them would be a demo helping itself
 *  to protocol vocabulary. So the JSON-RPC code says only which *kind* of
 *  wrong this is, and the answer — the operation's own code, and what to do
 *  instead — travels in `data`, where every client already looks. */
function asRpcError(e: unknown, method: string, log: HostLogger): unknown {
  if (e instanceof OpError) {
    log.warn(`${method} → ${e.code}`);
    return new RpcError(
      e.code === "bad_params" || e.code === "usage" ? RpcErrors.INVALID_PARAMS : RpcErrors.INTERNAL_ERROR,
      e.message,
      { code: e.code, ...(e.hint ? { hint: e.hint } : {}) }
    );
  }
  // The page said no. It travels with the page's own code, because "no tab
  // with id tab-9f2c" is an answer and a client can act on it.
  if (e instanceof PageRefusal) {
    log.warn(`${method} → ${e.code} (from the page)`);
    return new RpcError(RpcErrors.INTERNAL_ERROR, e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
  }
  // The command never got there. A different fix from every refusal above —
  // this is the narrative's exit 4, and the reason it is not exit 3.
  if (e instanceof PageError) {
    log.warn(`${method} → ${e.reason}`);
    return new RpcError(RpcErrors.INTERNAL_ERROR, e.message, { code: e.reason, ...(e.hint ? { hint: e.hint } : {}) });
  }
  return e;
}
