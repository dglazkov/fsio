// fsio protocol schemas (spec/PROTOCOL.md) — the single source of truth
// imported by host, web client, and benches. Drift between sides is our
// most likely future bug class; these types are the fence (#2).
export const PROTOCOL_VERSION = 0;
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
};
//# sourceMappingURL=protocol.js.map