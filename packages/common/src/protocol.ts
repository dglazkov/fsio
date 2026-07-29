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
}

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
