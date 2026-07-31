#!/usr/bin/env node
// `fsio` — the user's side of the hub: which folders the daemon may serve.
//
// The registry is daemon-private state (D20), so this CLI edits it
// directly rather than asking the daemon to; the daemon re-reads on change
// (Registry.reload), which is why `fsio share` takes effect at the next
// spawn judgment and not at the next restart.
//
// Paths appear *here* freely — this is the user's own terminal. The rule
// D22 states is that paths never reach the wire, and the daemon is what
// enforces it.
import path from "node:path";
import { Registry, type WorkspaceEntry } from "./registry.js";
import { ensureStateDir, hubDirPath, stateDirPath } from "./state.js";
import { runDaemon, DAEMON_USAGE } from "./daemon-cli.js";

const USAGE = `usage: fsio <command>

  share [dir]        register a workspace the daemon may run in (default: .)
      --name <n>     registry name (default: the folder's, lowercased)
      --label <l>    display text for consent prompts
      --profile <p>  profile governing spawned children (default: "default")
      --no-advertise keep the name out of the all-tenants service directory
      --replace      overwrite an existing entry of this name
  unshare <name>     remove a workspace
  workspaces         list them (--json for the machine-readable form)
  daemon [...]       run the hub daemon in the foreground (see --help)
  where              print the daemon-private state and hub paths

${DAEMON_USAGE}`;

// Explicitly typed (not just an annotated arrow): TS only treats a call as
// terminating control flow when the *variable* carries the never return.
const die: (msg: string) => never = (msg: string) => {
  console.error(`fsio: ${msg}`);
  process.exit(1);
};

const opt = (argv: string[], i: number, flag: string): string => argv[i] ?? die(`${flag} needs a value`);

function share(argv: string[]): void {
  const flags: { dir?: string; name?: string; label?: string; profile?: string; advertise: boolean; replace: boolean } = {
    advertise: true,
    replace: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--name") flags.name = opt(argv, ++i, "--name");
    else if (a === "--label") flags.label = opt(argv, ++i, "--label");
    else if (a === "--profile") flags.profile = opt(argv, ++i, "--profile");
    else if (a === "--no-advertise") flags.advertise = false;
    else if (a === "--replace") flags.replace = true;
    else if (a.startsWith("-")) die(`unknown flag ${a}`);
    else if (flags.dir === undefined) flags.dir = a;
    else die(`unexpected argument ${a}`);
  }
  const registry = new Registry(ensureStateDir());
  let entry: WorkspaceEntry;
  try {
    entry = registry.add(
      {
        dir: flags.dir ?? process.cwd(),
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.label ? { label: flags.label } : {}),
        ...(flags.profile ? { profile: flags.profile } : {}),
        advertise: flags.advertise,
        replace: flags.replace,
      },
      hubDirPath()
    );
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  console.log(`shared ${entry.path}`);
  console.log(`  workspace: ${entry.name}${entry.advertise ? "" : " (not advertised)"} · profile: ${entry.profile}`);
  console.log(`  a page asks for it by name; the path stays on this machine (D22).`);
}

function unshare(argv: string[]): void {
  const name = argv[0] ?? die("usage: fsio unshare <name>");
  const registry = new Registry(ensureStateDir());
  if (!registry.remove(name)) die(`no workspace named ${name}`);
  console.log(`unshared ${name}`);
  console.log(`  running sessions keep their working directory; the name stops resolving now (1006).`);
}

function workspaces(argv: string[]): void {
  const registry = new Registry(stateDirPath());
  const list = registry.list();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log("no workspaces shared — run `fsio share <dir>`");
    return;
  }
  const w = Math.max(...list.map((e) => e.name.length));
  for (const e of list) {
    const tags = [e.profile === "default" ? null : `profile: ${e.profile}`, e.advertise ? null : "not advertised"].filter(Boolean);
    console.log(`${e.name.padEnd(w)}  ${e.path}${tags.length ? `  (${tags.join(", ")})` : ""}`);
  }
}

function where(): void {
  console.log(`hub:    ${hubDirPath()}`);
  console.log(`state:  ${stateDirPath()}`);
  console.log(`\nThe hub is the folder a page grants once, ever. Everything in it is readable by`);
  console.log(`every granted origin (D20) — the registry, grants, and profiles live in state,`);
  console.log(`outside the grant, which is why ${path.basename(stateDirPath())} is not in the hub.`);
}

const [cmd = "", ...rest] = process.argv.slice(2);
switch (cmd) {
  case "share":
    share(rest);
    break;
  case "unshare":
    unshare(rest);
    break;
  case "workspaces":
  case "ws":
    workspaces(rest);
    break;
  case "where":
    where();
    break;
  case "daemon":
    process.exit(await runDaemon(rest));
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    if (cmd) console.error(`fsio: unknown command ${cmd}\n`);
    console.error(USAGE);
    process.exit(cmd ? 1 : 0);
}
