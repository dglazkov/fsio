// One command, from a terminal to a page, over a folder.
//
// This is the CLI's whole transport story and it is deliberately a
// function: cli.ts wraps argv around it, and the hermetic end-to-end test
// calls it directly, so the thing under test is the thing that ships.
//
// A session per invocation is not a workaround for anything — it is what an
// fsio client that lives for 40 ms looks like. Opening it is also how the
// CLI asks "is there a page?": the `actuate` kind answers that in its spawn
// result (kinds.ts), before this process has written a command anywhere.
import { FsioClient, type FsDirectory } from "@fsio/client";
import { decodeOutcome, encode, invoke, type Outcome } from "./messages.js";
import type { Operation } from "./model.js";

/** What went wrong before the page ever saw the command. `no_helper` and
 *  `no_page` are two different missing things and two different fixes:
 *  start the helper, or open the page. */
export class CliError extends Error {
  constructor(
    readonly reason: "no_helper" | "no_page" | "timeout" | "transport",
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface ActuateOptions {
  /** How long to wait for the page's answer. The helper holds its own,
   *  longer deadline; whichever fires first ends the wait. */
  timeoutMs?: number;
  /** Uplink poll interval. 15 ms matches what the agent page uses — a CLI
   *  invocation is two round trips and then gone, so this is the only knob
   *  that shows up in `time actuator …`. */
  pollMs?: number;
}

export async function actuate(dir: FsDirectory, op: Operation, opts: ActuateOptions = {}): Promise<Outcome> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const client = new FsioClient(dir);

  // Probe for .fsio WITHOUT creating it — connect() would `create: true` one
  // into whatever folder was named, so a typo'd path would come back
  // "no helper here" *and* leave a directory behind. The page takes the same
  // care for the same reason (web/session.ts).
  await dir.getDirectoryHandle(".fsio").catch(() => {
    throw new CliError(
      "no_helper",
      `no helper is running in this folder`,
      "start it in that folder first: npm run actuator-helper -- <folder>"
    );
  });

  const host = await client.connect().catch((e: unknown) => {
    throw new CliError("transport", `cannot read the folder: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!host.alive) {
    throw new CliError(
      "no_helper",
      host.info ? `the helper stopped (last heartbeat ${Math.round(host.ageMs / 1000)}s ago)` : "no helper is running in this folder",
      "start it in that folder first: npm run actuator-helper -- <folder>"
    );
  }

  const session = client.createSession(
    { kind: "actuate", client: "actuator-cli" },
    { pollMs: opts.pollMs ?? 15, heartbeatMs: 0 }
  );

  // Listeners before the first await: createSession is synchronous exactly
  // so nothing can be missed here (D11).
  let settle!: (o: Outcome) => void;
  let fail!: (e: Error) => void;
  const answer = new Promise<Outcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  session.on("data", (bytes) => {
    const msg = decodeOutcome(bytes);
    if (msg) settle(msg);
  });
  session.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));

  const timer = setTimeout(
    () =>
      fail(
        new CliError(
          "timeout",
          `no answer within ${timeoutMs}ms`,
          // Both readings are live and the CLI cannot tell them apart: a page
          // that died without closing its session still looks attached to the
          // helper, and a page in a background tab is genuinely just slow
          // (F16: hidden tabs beat once a minute). Only the protocol's detach
          // window separates them, and it is minutes long by design.
          "the page may have been closed without closing its session, or it may be a background tab (browsers clamp those to one timer a minute)"
        )
      ),
    timeoutMs
  );

  try {
    const info = await session.ready.catch((e: unknown) => {
      throw new CliError("transport", e instanceof Error ? e.message : String(e));
    });
    // The helper says whether a page is listening in its spawn result
    // (kinds.ts). Nothing has been asked for yet, so this costs nothing to
    // give up on.
    if (info["attached"] !== true) {
      throw new CliError(
        "no_page",
        "no page is open on this folder",
        "open the actuator page, pick this folder, and grant it"
      );
    }
    session.sendData(encode(invoke(op)));
    return await answer;
  } finally {
    clearTimeout(timer);
    // The host owns the session dir (D6); close() only says we are done.
    await session.close().catch(() => {});
  }
}
