// The `pewt` session kind: the host's half of the API.
//
// A kind is "a set of RPC methods plus a DATA sink/source — bring your own
// semantics" (D13), and this one is all methods and no data. Every operation
// in the table becomes an RPC method, so a client that can open a session in
// this folder can call the whole API and nothing else.
//
// Both front ends open this same kind. `pewt repos` in a terminal and
// `pewt.repos.list()` in an extension are the same session, the same method,
// and the same table — which is what stops the two surfaces from drifting.
import { RpcError, RpcErrors } from "@fsio/common";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { OPERATIONS, OpError } from "./ops.js";
import type { Pewter } from "./pewter.js";

export function pewtKind(p: Pewter, log: HostLogger): KindHandler {
  const methods: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const op of OPERATIONS) {
    methods[op.method] = async (params: unknown) => {
      try {
        const result = await op.run(p, op.parse(params));
        log.info(`${op.method} → ok`);
        return result;
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        log.warn(`${op.method} → ${e.code}`);
        // An operation's refusal is not one of the protocol's numbered
        // failures, and taking a number out of the 1001–1007 range for it
        // would be a demo helping itself to protocol vocabulary. So the
        // JSON-RPC code says only which *kind* of wrong this is, and the
        // answer — the operation's own code, and what to do instead —
        // travels in `data`, where every client already looks.
        throw new RpcError(
          e.code === "bad_params" || e.code === "usage" ? RpcErrors.INVALID_PARAMS : RpcErrors.INTERNAL_ERROR,
          e.message,
          { code: e.code, ...(e.hint ? { hint: e.hint } : {}) }
        );
      }
    };
  }

  return (ctx: KindContext): KindSession => {
    log.info(`● client attached (${ctx.sessionId}) — ${String(ctx.spec["client"] ?? "unnamed")}`);
    return {
      // What the client learns on connect. The operation list is here
      // because the shell ships on our schedule and `pewt` is installed on
      // yours: the two can disagree about the API, and a client that can see
      // what this host actually serves can say so plainly instead of failing
      // at the call. Noticing that disagreement is not designed yet
      // (NARRATIVE.md, "What is not built") — this is the fact it will need.
      result: { pewter: p.name, operations: OPERATIONS.map((o) => o.method) },
      methods,
      onClose: () => log.info(`○ client detached (${ctx.sessionId})`),
    };
  };
}
