#!/usr/bin/env node
// actuator-demo helper: the switchboard between a terminal and a page.
//
// Run it in a folder, open the page, grant that folder, and every
// `actuator …` you type in that folder reaches the page. The helper holds
// no application state and spawns no process — it registers two session
// kinds (kinds.ts) and routes between them, which is why this file is
// mostly banner.
//
// Usage:  actuator-demo-helper [dir]     (default: current directory)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServer } from "@fsio/host";
import { actuatorKinds } from "./kinds.js";
import { Router } from "./router.js";

const PAGE_URL = process.env["FSIO_ACTUATOR_PAGE"] ?? "http://localhost:8768/";

const fail = (msg: string): never => {
  console.error(`fsio actuator-demo: ${msg}`);
  process.exit(1);
};

const rootArg = process.argv[2];
if (rootArg?.startsWith("-")) fail(`unknown flag ${rootArg} — usage: actuator-demo-helper [dir]`);
const root = path.resolve(rootArg ?? process.cwd());
if (rootArg) fs.mkdirSync(root, { recursive: true });
const rootReal = fs.realpathSync(root);

// F9: FileSystemObserver dies with InvalidModificationError under /tmp, and
// a demo run from there looks broken in ways nobody would connect to the
// folder choice.
const tmpReal = fs.realpathSync(os.tmpdir());
if (rootReal.startsWith("/private/tmp") || rootReal.startsWith(tmpReal)) {
  fail(`refusing to run under a temp dir (${rootReal}) — Chrome's file observers break there (F9). Use a real working folder.`);
}

const line = (tag: string, a: unknown[]): void => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const router = new Router();
const kinds = actuatorKinds(router, log);

const server = new HostServer({
  root: rootReal,
  // No kind here starts a process, so there is nothing for a spawn policy
  // to protect: the page's session carries JSON one way and JSON the other,
  // and the CLI's carries one command. Shell stays off.
  fresh: true, // a restarted helper should never inherit stale sessions
  logger: log,
});
server.registerKind("actuator", kinds.actuator);
server.registerKind("actuate", kinds.actuate);

// The live-host refusal (#40 — a second helper on the same folder) is an
// operator message, not a crash.
await server.start().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

const folderName = path.basename(rootReal);
console.log(`
fsio actuator demo · serving ${rootReal}

  1. open  ${PAGE_URL}
  2. pick this folder in the page:  ${folderName}
  3. drive it from here:

       npm run actuator -- --dir ${rootReal} tabs add --title Build --message "CI is running"
       npm run actuator -- --dir ${rootReal} tabs list

  Commands travel as files in ${folderName}/.fsio — nothing else connects
  the two, and nothing is applied while no page is open.

waiting for a page… (Ctrl-C stops the helper and cleans up .fsio; a page
  that self-reported leaves its report in .fsio/client/)
`);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — closing sessions…`);
  router.close();
  await server.close();
  server.cleanServiceDir(true);
  // The page's self-report is the page's, not the host's to sweep (D6's
  // #109 amendment) — it is the only record of what a run proved.
  const clientDir = path.join(rootReal, ".fsio", "client");
  const reports = fs.existsSync(clientDir) ? fs.readdirSync(clientDir).length : 0;
  console.log(reports ? `done; .fsio swept, ${reports} page report${reports === 1 ? "" : "s"} kept in .fsio/client/.` : "done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
