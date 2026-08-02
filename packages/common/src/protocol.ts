// fsio protocol schemas (spec/PROTOCOL.md) — the single source of truth
// imported by host, web client, and benches. Drift between sides is our
// most likely future bug class; these types are the fence (#2).

export const PROTOCOL_VERSION = 0;

/** `.fsio/fsio.json` */
export interface FsioManifest {
  protocol: number;
}

/** `.fsio/host.json` — heartbeat, rewritten atomically every 2 s. */
export interface HostInfo {
  pid: number;
  protocol: number;
  allowShell: boolean;
  pty: boolean;
  startedAt: number;
  seq: number;
  t: number;
  /** revision of `.fsio/services.json` (D24) — the doorbell. A client
   *  already statting this file learns from a changed value that the
   *  (larger, colder) capability document is worth re-reading; the same
   *  hot-pointer/cold-state split as `out.sig` (D3). Absent on hosts that
   *  publish no service directory. */
  servicesRev?: number;
}

// ---- service directory (D24/D25): the origin-facing capability document

/** One entry of `services.json`'s `kinds` — D13's registry surfaced to
 *  pages. `needsGrant` means a D23 grant is required *before* the per-request
 *  policy is even consulted; a hub-confined kind (`echo`) is served without
 *  one. Absent = the host makes no claim. */
export interface ServiceKind {
  name: string;
  needsGrant?: boolean;
  /** Embedder-supplied detail about this kind, transcribed verbatim and
   *  interpreted by nobody in the library (D31). The protocol says only
   *  that it is a JSON object; its keys are a contract between one embedder
   *  and the page that knows it, which is why a client detects it by
   *  **presence** rather than by a capability name — an unknown `detail` is
   *  ignorable, and a facility every peer must agree on is not what this
   *  field is for. Subject to the same privacy line as the rest of the
   *  document (D24): one file serves every granted origin, so no paths and
   *  no secrets. */
  detail?: Record<string, unknown>;
}

/** One advertisable workspace: a **name**, never a path (D22/D24). `label`
 *  is display text for consent UIs — the legitimate need paths were
 *  rejected for. */
export interface ServiceWorkspace {
  name: string;
  label?: string;
}

/** `.fsio/services.json` — host-owned, temp+renamed ONLY when its content
 *  changes (D24). One file serves all tenants, so it carries only what
 *  every granted origin may see: advertisable workspace names, never paths
 *  and never the full registry. Per-origin visibility is a property of the
 *  grant, carried by its receipt (D23). */
export interface ServicesDoc {
  /** increments on every content change; mirrored into `host.json`. */
  rev: number;
  protocol: number;
  /** feature-detected capability names (D25) — see `CAPABILITIES`. */
  capabilities: string[];
  kinds: ServiceKind[];
  workspaces?: ServiceWorkspace[];
  /** the consent endpoint, when a host serves one (D23 rule 6). */
  consent?: { url: string };
}

/** The capability-name registry (D25). Names are stable and never reused —
 *  the same discipline as F and D numbers, so a withdrawn capability burns
 *  its name. Clients feature-detect on these and MUST NOT gate behavior on
 *  a `protocol` range where a name would do; an unknown name is never
 *  fatal. #8 keeps the job of growing this list. */
export const CAPABILITIES = {
  /** `kind: "shell"` may be requested (the D12 policy still judges each). */
  SHELL: "shell",
  /** shell sessions get a real pty rather than the pipe fallback (D14). */
  PTY: "pty",
  /** `attach` is served: takeover with writer epochs and replay (D18). */
  ATTACH: "attach",
  /** `workspace` names resolve to roots this host serves (D22). */
  WORKSPACES: "workspaces",
} as const;

/** `sessions/<id>/out.sig` — doorbell + stream map (rename-committed). */
export interface OutSig {
  /** current segment number */
  gen: number;
  /** bytes in the current segment */
  size: number;
  /** final size of segment gen-1 (reader handoff point) */
  prevFinal: number;
  /** cumulative bytes ever appended (ack accounting) */
  total: number;
}

export type SessionState = "running" | "exited" | "error";

/** `sessions/<id>/status.json` — host-owned durable state record. */
export interface SessionStatus {
  t: number;
  state: SessionState;
  kind?: string;
  pid?: number;
  pty?: boolean;
  cmd?: string;
  exitCode?: number | null;
  error?: string;
  closedByClient?: boolean;
  /** running session whose client stopped heartbeating (D17): the session
   *  is alive but unattended — a reattach candidate, not a corpse. Cleared
   *  when uplink activity resumes. */
  detached?: boolean;
  /** current uplink writer (D18). Absent = the spawning client (epoch 0,
   *  uplink `in/`). Each attach grant bumps `epoch` and moves the uplink
   *  to `in.<epoch>/`; a client observing an epoch above its own has been
   *  superseded and MUST stop committing chunks (the fence that keeps
   *  one-writer-per-file true across takeovers, F8/D6). */
  writer?: { epoch: number; aid: string };
}

/** `transcripts/<id>/meta.json` — what an ended session left behind (D26
 *  rule 4, #119). The out log beside it is the *agent's* half of a
 *  conversation, read back by replaying its DATA frames through the same
 *  handlers that consumed them live; the human's half was never on the
 *  downlink and is the reader's own to carry (D32 rule 2).
 *
 *  Written once, by the host, when the session's directory is swept. Every
 *  field is a claim by whoever wrote the file — a reader parses it
 *  defensively and renders it as text, never as authority (D20). */
export interface TranscriptMeta {
  id: string;
  /** the session's kind, or null when spawn.json was never readable. */
  kind: string | null;
  client?: string;
  origin?: string;
  /** epoch ms at which the host swept the session. */
  ended: number;
  /** what ended it, for display: the human's close, the host shutting
   *  down, a client that vanished, a stale leftover. */
  why: string;
  exitCode?: number | null;
  /** generation of the OLDEST segment kept. Above 0 means the log rotated
   *  and this is the conversation's tail, not the whole of it (D26 rule 1,
   *  #57) — a reader that does not say so is lying by omission. */
  gen: number;
  /** cumulative bytes the session ever wrote, against `bytes` — what
   *  survived. Unequal is the same suffix story `gen` tells. */
  total: number;
  bytes: number;
}

// ---- spawn (the request carried by spawn.json; see spec "Control plane")

export interface EchoSpawn {
  kind: "echo";
  /** free-form client identification, diagnostics only */
  client?: string;
  /** web origin of the creating page — stamped by the client library,
   *  advisory/display-only (D15; spec "Session kinds"). */
  origin?: string;
}

export interface ShellSpawn {
  kind: "shell";
  cols?: number;
  rows?: number;
  cmd?: string;
  args?: string[];
  /** hub deployment (D22): the NAME of a workspace in the host's registry,
   *  never a path — the page has none to give (a picked handle carries no
   *  path) and the host must not disclose one into a co-tenant-readable
   *  folder (D20). Required when the host serves more than one workspace;
   *  unresolvable or omitted-where-required is `1006`. */
  workspace?: string;
  /** relative to the workspace root (or the shared dir, one-folder mode);
   *  MUST NOT escape it (D22). */
  cwd?: string;
  /** false forces the pipe fallback even when node-pty is available */
  pty?: boolean;
  client?: string;
  /** web origin of the creating page (D15) — advisory, display-only. */
  origin?: string;
}

/** Registered-kind sessions (D13): the host-side kind handler defines the
 *  spec's meaning; the protocol only requires `kind`. */
export interface KindSpawn {
  kind: string;
  /** free-form client identification, diagnostics only */
  client?: string;
  /** web origin of the creating page (D15) — advisory, display-only. */
  origin?: string;
  [param: string]: unknown;
}

export type SpawnSpec = EchoSpawn | ShellSpawn | KindSpawn;

/** Result of a successful `spawn` request. */
export interface SpawnResult {
  kind: string;
  pid: number;
  pty?: boolean;
  cmd?: string;
  /** registered kinds may add result fields (D13). */
  [extra: string]: unknown;
}

// ---- control-plane method registry (spec "Control plane"; D10)

export interface PingParams {
  t0: number;
  filler?: string;
}

/** Params echoed back plus host receive (t1) / append (t2) timestamps. */
export interface PingResult extends PingParams {
  t1: number;
  t2: number;
}

export interface ResizeParams {
  cols: number;
  rows: number;
}

export interface SignalParams {
  sig?: string;
}

export interface AckParams {
  total: number;
}

/** `attach` request params (D18) — rides `attach.<aid>.json`, the same
 *  file-as-bootstrap-transport trick as spawn.json (the host only consumes
 *  the current writer's uplink, so a would-be writer cannot ask there). */
export interface AttachParams {
  /** attacher id, unique per attach attempt; also embedded in the file
   *  name so concurrent attachers never share a file (F8/D6). */
  aid: string;
  /** free-form client identification, diagnostics only */
  client?: string;
  /** web origin of the attaching page (D15) — advisory, display-only. */
  origin?: string;
}

/** `attach` result: the spawn-result shape plus the granted writer epoch
 *  (the attacher's uplink becomes `in.<epoch>/`). */
export interface AttachResult extends SpawnResult {
  epoch: number;
}
