// Folder → client → agent. Gates, the picker, the spawn, and the two
// pollers. Writes signals (state.ts); owns the FsioClient singleton.
import { FsioClient, RpcError, type FsioSession } from "@fsio/client";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter, step } from "./reporter";
import {
  agentFacts,
  agents,
  diagnostics,
  folder,
  gate,
  helper,
  notice,
  phase,
  pickError,
  pushEntry,
  turn,
  wizardStep,
  type AgentOffer,
  type Diagnostics,
} from "./state";
import { startWatching } from "./workspace";

let client: FsioClient | null = null;
let session: FsioSession | null = null;
let agent: AgentSession | null = null;

// ---------------------------------------------------------------- gates

export function checkGates(): void {
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "This demo needs Chrome (or a Chromium browser).",
      hint: "It's built on the File System Access API — the page talks to your machine, and to the agent, through files in a folder you grant it. That API hasn't shipped elsewhere yet.",
    });
  }
}

/** The helper is macOS-only while confinement is sandbox-exec; the wizard
 *  says so louder when the page isn't on a Mac. */
export const onMac = navigator.platform.startsWith("Mac");

// ---------------------------------------------------------------- connect

let hostTimer: ReturnType<typeof setInterval> | undefined;
let diagTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;
/** The revision of the service directory this page has already read. The
 *  heartbeat carries it (D3's doorbell), so re-reading is free to skip
 *  until it moves — which is also what makes "install an agent and watch it
 *  appear" cost nothing while nobody is installing anything. */
let servicesRev: number | undefined;
/** Kept so the agent chooser can start a session after the wizard has
 *  already run. */
let rootHandle: FileSystemDirectoryHandle | null = null;

export async function pickFolder(): Promise<void> {
  pickError.set(null);
  step("opening the folder picker");
  let root: FileSystemDirectoryHandle;
  try {
    root = await showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // cancelled — not an error
  }
  await connectTo(root);
}

async function connectTo(root: FileSystemDirectoryHandle): Promise<void> {
  step(`connecting to ${root.name}/`);
  pickError.set(null);
  folder.set({ name: root.name });
  rootHandle = root;
  servicesRev = undefined;
  clearInterval(hostTimer);
  // Probe for .fsio WITHOUT creating it: `connect()` would create one in
  // whatever folder was picked, littering the wrong folder and hiding the
  // "no helper here" case (terminal-demo learned this on its first click).
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await root.getDirectoryHandle(".fsio");
  } catch {
    helper.set("none");
    pickError.set({
      msg: `no helper in ${root.name}/`,
      hint: "Is the command from step 1 running, in exactly this folder? The helper creates a .fsio directory there — we don't see one. (Nothing was written to the folder you just picked.)",
    });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: root.name });
  } catch (e) {
    pickError.set({ msg: `could not open ${root.name}/.fsio`, hint: e instanceof Error ? e.message : String(e) });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  helperWasAlive = false;
  await refreshHelper(root);
  hostTimer = setInterval(() => void refreshHelper(root), 2000);
  if (helper.get() !== "alive") {
    wizardStep.set(2);
    phase.set("wizard");
  }
}

async function refreshHelper(root: FileSystemDirectoryHandle): Promise<void> {
  if (!client) return;
  const host = await client.hostInfo();
  if (!host.alive) {
    helperWasAlive = false;
    helper.set("silent");
    return;
  }
  // Re-read the directory on the first beat and on every revision bump
  // after it — the roster is live, so an agent installed while this page
  // sits on the install card lands here without a reload.
  const rev = host.info?.servicesRev;
  const first = !helperWasAlive;
  if (!first && rev === servicesRev) return;
  helperWasAlive = true;
  servicesRev = rev;

  // D25's handshake, used for what it is for: this page needs one specific
  // kind, and a host that doesn't serve it should say so here rather than
  // through a spawn failure three clicks later.
  const services = await client.services(rev);
  const acp = (services?.kinds ?? []).find((k) => k.name === "acp");
  if (first) reporter.event("helper-alive", { kinds: (services?.kinds ?? []).map((k) => k.name) });
  if (!acp) {
    const kinds = (services?.kinds ?? []).map((k) => k.name);
    helper.set("wrong-kind");
    pickError.set({
      msg: `the helper in ${root.name}/ doesn't serve ACP sessions`,
      hint: `It advertises: ${kinds.join(", ") || "(nothing)"}. This page needs the ACP helper — that's the command in step 1, not the terminal demo's.`,
    });
    phase.set("wizard");
    wizardStep.set(1);
    return;
  }
  helper.set("alive");

  const roster = readRoster(acp.detail);
  agents.set(roster);
  if (session) return; // an agent is already running; a roster change is news for nobody

  // A helper that publishes no roster is a pre-#102 one. Unknown detail is
  // "not supported", never an error (D25), so let it choose for itself —
  // exactly what every run did before this existed.
  if (roster === null) {
    await startAgent(root, null);
    return;
  }

  const ready = roster.filter((a) => a.installed);
  reporter.event("roster", { installed: ready.map((a) => a.name), known: roster.length });
  // One agent: name it and go — the page has nothing to ask about. Zero or
  // several: the human decides, which is the whole point (the helper used
  // to pick the first that resolved, silently).
  if (ready.length === 1) {
    await startAgent(root, ready[0]!.name);
    return;
  }
  phase.set("wizard");
  wizardStep.set(3);
}

/** The roster as published by the helper (#102). Everything here arrives as
 *  a file that any co-tenant of the folder can write (D20), so it is parsed
 *  defensively and never trusted into anything but display — the name goes
 *  back to the helper on a spawn, where the allow-list judges it again. */
function readRoster(detail: Record<string, unknown> | undefined): AgentOffer[] | null {
  const raw = detail?.["agents"];
  if (!Array.isArray(raw)) return null;
  const out: AgentOffer[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["title"] !== "string") continue;
    out.push({
      name: r["name"],
      title: r["title"],
      install: typeof r["install"] === "string" ? r["install"] : "",
      installed: r["installed"] === true,
      asks: r["asks"] === true,
    });
  }
  return out;
}

/** The chooser's button (#102): the human picked, so the spawn names it. */
export async function chooseAgent(name: string): Promise<void> {
  if (!rootHandle || session) return;
  await startAgent(rootHandle, name);
}

// ---------------------------------------------------------------- the agent

/** `agent` is the name the human chose, or null to let the helper pick —
 *  which is what a helper too old to publish a roster gets. Either way the
 *  wire carries a **name**, never a path: the allow-list is host-side and
 *  judges it again (D30 rule 4). */
async function startAgent(root: FileSystemDirectoryHandle, name: string | null): Promise<void> {
  if (!client || session) return;
  step(name ? `asking the helper for ${name}` : "asking the helper for an agent");
  // What the page *asked* for, beside what the host reports it *started*
  // (`agent-started`): the pair is how a cooperative run verifies that the
  // chooser chose, rather than that the helper picked first-installed.
  reporter.event("agent-chosen", { agent: name });
  turn.set("starting");
  phase.set("chat");
  const s = client.createSession({ kind: "acp", client: "acp-demo", ...(name ? { agent: name } : {}) }, { pollMs: 15 });
  session = s;
  const conn = new AcpConnection(s, {
    onTraffic: (dir, msg) => reporter.event("acp", { dir, method: (msg as { method?: string }).method ?? null }),
    onUnhandled: (method) => log(`agent asked for something this client doesn't implement: ${method}`),
  });

  s.on("status", (st) => {
    if (st.state !== "exited" && st.state !== "error") return;
    turn.set("gone");
    // #98: the kind's methods are gone the moment it exits, so the last
    // diagnostics snapshot is all we will ever have of the stderr that
    // says why. Stop polling and keep what we hold.
    clearInterval(diagTimer);
    const tail = diagnostics.get()?.stderr ?? [];
    pushEntry({
      kind: "error",
      text:
        `the agent exited${st.exitCode === undefined || st.exitCode === null ? "" : ` (code ${st.exitCode})`}` +
        (tail.length ? `\nlast stderr:\n${tail.slice(-6).join("\n")}` : ""),
    });
    reporter.event("agent-exited", { exitCode: st.exitCode ?? null, stderrTail: tail.slice(-6) });
  });

  let facts: Record<string, unknown>;
  try {
    await s.ready;
    facts = (await s.request<Record<string, unknown>>("acp/info")).result;
  } catch (e) {
    // A refusal from the host — no agent on PATH, an unknown name, a
    // sandbox that could not be applied (D30 rule 5: it fails, it does not
    // quietly run unconfined). The message is written to be read by a
    // human, so show it as one.
    const msg = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
    notice.set({ msg: "the helper refused to start an agent", hint: msg });
    pushEntry({ kind: "error", text: msg });
    turn.set("gone");
    reporter.event("spawn-refused", { error: msg });
    return;
  }

  agentFacts.set({
    agent: String(facts["agent"] ?? "agent"),
    title: String(facts["title"] ?? ""),
    sandboxed: !!facts["sandboxed"],
    confinement: String(facts["confinement"] ?? ""),
    profile: (facts["profile"] as string | null) ?? null,
    state: facts["state"] as { mode: string; dirs: string[]; why: string },
    cwd: String(facts["cwd"] ?? ""),
  });
  reporter.event("agent-started", { agent: facts["agent"], sandboxed: facts["sandboxed"] });
  log(`agent ${String(facts["agent"])} · ${String(facts["confinement"])}`);

  startWatching(root);
  diagTimer = setInterval(() => void pollDiagnostics(), 3000);

  agent = new AgentSession(conn, root, String(facts["cwd"] ?? ""));
  try {
    const init = await agent.start();
    turn.set("idle");
    pushEntry({ kind: "note", text: `${init.agentName} ${init.agentVersion} is listening in ${root.name}/` });
    reporter.event("acp-ready", { agent: init.agentName, version: init.agentVersion, sessionId: agent.sessionId });
    step("agent ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The F28 shape: `initialize` passes and `session/new` fails, with a
    // message that names a stream rather than a policy. Show the agent's
    // own words AND what the page knows about the wall it is behind.
    const conf = agentFacts.get();
    pushEntry({
      kind: "error",
      text: `the agent could not start a session: ${msg}` + (conf?.sandboxed ? `\n\nit is confined — ${conf.confinement}` : ""),
    });
    turn.set("gone");
    reporter.event("acp-start-failed", { error: msg });
  }
}

async function pollDiagnostics(): Promise<void> {
  if (!session) return;
  try {
    const { result } = await session.request<Diagnostics>("acp/diagnostics");
    diagnostics.set(result);
  } catch {
    // exited (#98) or in flight — the last snapshot stands
  }
}

// ---------------------------------------------------------------- input

export function sendPrompt(text: string): void {
  const a = agent;
  if (!a || turn.get() !== "idle") return;
  void a.prompt(text);
}

export function cancelTurn(): void {
  agent?.cancel();
}

/** Page teardown: close the session so the helper kills the agent (D6). */
export function closeOnPagehide(): void {
  agent?.conn.close();
  void session?.close();
  session = null;
  agent = null;
}
