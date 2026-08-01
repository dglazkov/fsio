// Folder → client → agent. Gates, the picker, the spawn, and the two
// pollers. Writes signals (state.ts); owns the FsioClient singleton.
import { FsioClient, RpcError, type FsioSession } from "@fsio/client";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter, step } from "./reporter";
import { agentFacts, diagnostics, folder, gate, helper, notice, phase, pickError, pushEntry, turn, wizardStep, type Diagnostics } from "./state";
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
  if (helperWasAlive) return;
  helperWasAlive = true;
  // D25's handshake, used for what it is for: this page needs one specific
  // kind, and a host that doesn't serve it should say so here rather than
  // through a spawn failure three clicks later.
  const services = await client.services(host.info?.servicesRev);
  const kinds = (services?.kinds ?? []).map((k) => k.name);
  reporter.event("helper-alive", { kinds });
  if (!kinds.includes("acp")) {
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
  await startAgent(root);
}

// ---------------------------------------------------------------- the agent

async function startAgent(root: FileSystemDirectoryHandle): Promise<void> {
  if (!client || session) return;
  step("asking the helper for an agent");
  turn.set("starting");
  phase.set("chat");
  const s = client.createSession({ kind: "acp", client: "acp-demo" }, { pollMs: 15 });
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
