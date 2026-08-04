// The two session kinds this demo registers (D13: kinds are a host-side
// registry, "bring your own semantics"). Neither spawns a process — the
// helper is a switchboard, not a launcher, so there is nothing here to
// confine and no spawn policy to argue about.
//
//   actuator — the page's session. Long-lived, one per open page, newest
//              wins. Commands go down it; receipts come back up it.
//   actuate  — a CLI invocation's session. Short-lived: opens, sends one
//              command, reads the answer, exits.
//
// The direction is the whole point. A page opens both sessions' *transport*
// — the client always creates sessions (spec: Session lifecycle) — and yet
// what flows is control from the machine to the page. Who dials and who
// drives are different questions, and only the first one is the protocol's.
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { AppError } from "./model.js";
import {
  decodeInvocation,
  decodeUpstream,
  encode,
  failure,
  outcome,
  asOperation,
} from "./messages.js";
import { ChannelError, Router } from "./router.js";

/** How long a CLI invocation waits for the page before the helper gives up
 *  on its behalf. Generous next to a p50 5.3 ms browser round trip (F3):
 *  what it actually covers is a page whose tab is in the background and
 *  clamped to a 1/min timer (F16). */
const COMMAND_TIMEOUT_MS = 15_000;

export interface ActuatorKinds {
  actuator: KindHandler;
  actuate: KindHandler;
}

export function actuatorKinds(router: Router, log: HostLogger): ActuatorKinds {
  return {
    actuator: (ctx: KindContext): KindSession => {
      const { displaced } = router.attachPage({
        id: ctx.sessionId,
        send: (msg) => ctx.write(encode(msg)),
      });
      if (displaced) log.warn(`page ${ctx.sessionId} took over from ${displaced}`);
      log.info(`● page attached (${ctx.sessionId}) — commands will be delivered here`);

      return {
        result: { attached: true, displaced },
        onData: (bytes) => {
          const msg = decodeUpstream(bytes);
          if (!msg) return void log.warn("dropped an unreadable frame from the page");
          // A receipt nobody awaits is legal — a duplicate, or one that lost
          // a race with a timeout. Log it and carry on.
          if (!router.receipt(msg)) log.warn(`receipt ${msg.id} matched no waiting command`);
        },
        onClose: () => {
          if (router.detachPage(ctx.sessionId)) log.info(`○ page detached (${ctx.sessionId})`);
        },
      };
    },

    actuate: (ctx: KindContext): KindSession => {
      // "Is anyone home?" is answered by the spawn *result*, not by failing
      // the spawn: @fsio/host flattens every kind-handler throw to `1002
      // spawn-failed` with a message, so a kind cannot raise a code of its
      // own (measured — it is what the first version of this file tried).
      // D13 lets a kind add fields to the spawn result, so the answer goes
      // there, and the CLI still learns it before writing any command.
      return {
        result: { attached: router.attached, page: router.pageId },
        onData: (bytes) => {
          const msg = decodeInvocation(bytes);
          const op = msg && asOperation(msg);
          if (!op) {
            ctx.write(
              encode(failure({ kind: "channel", code: "bad_request", message: "unreadable or unsupported command" }))
            );
            return void ctx.exit(2);
          }
          void router
            .dispatch(op, COMMAND_TIMEOUT_MS)
            .then((result) => {
              log.info(`${op.method} → ok`);
              ctx.write(encode(outcome(result)));
              ctx.exit(0);
            })
            .catch((err: unknown) => {
              const answer =
                err instanceof AppError
                  ? failure({ kind: "app", code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) })
                  : err instanceof ChannelError
                    ? failure({ kind: "channel", code: err.reason, message: err.message })
                    : failure({
                        kind: "channel",
                        code: "internal",
                        message: err instanceof Error ? err.message : String(err),
                      });
              log.warn(`${op.method} → ${answer.ok ? "ok" : answer.error.code}`);
              ctx.write(encode(answer));
              // One command per session: answering is the whole job, so the
              // session goes terminal immediately rather than lingering as
              // a `running` dir if the CLI is killed before it closes.
              ctx.exit(1);
            });
        },
      };
    },
  };
}
