// A shell, as an extension holds one — and the one place `--repo site`
// becomes a working directory.
//
// Every other operation is a question with an answer. A shell is a
// conversation: bytes go in, bytes come out, and it ends in an exit code. So
// `pewt.shell()` hands back something live rather than a result, and the call
// it opened stays open for as long as the shell runs.
//
// **Why the translation happens here rather than on the host.** `run` is a
// session kind this project wrote, so `{script, repo}` could travel as-is and
// be resolved against the disk on the other side. A shell is @fsio/host's own
// kind — it has the pty, the resize plumbing and the flow control — and its
// spec is the library's: a working directory relative to the folder, and a
// size. That spec has to be built before it is sent, and it is built once,
// for `pewt shell --repo site` and `pewt.shell({ repo: "site" })` alike.
//
// Nothing here is a check. The host refuses a `cwd` that escapes the folder
// (D22 containment) and Pewter's spawn policy refuses one that is not a
// project; a client validating on the host's behalf would only be deciding
// what error message it prefers.
/** Options → the spec that goes on the wire. A `repo` that is not a plain
 *  directory name is passed through unchanged rather than cleaned up: the
 *  host refuses it, and a client that quietly rewrites a name would run
 *  somewhere other than where it was asked to. */
export function shellSpec(options = {}) {
    return {
        ...(options.repo !== undefined ? { cwd: `repos/${options.repo}` } : {}),
        ...(options.cols !== undefined ? { cols: options.cols } : {}),
        ...(options.rows !== undefined ? { rows: options.rows } : {}),
    };
}
/** The project a spec's `cwd` names, or null for the pewter itself. Read
 *  back out for the sentence the host's question shows. */
export function repoOfCwd(cwd) {
    if (!cwd)
        return null;
    const rest = cwd.startsWith("repos/") ? cwd.slice("repos/".length) : null;
    return rest && !rest.includes("/") ? rest : null;
}
//# sourceMappingURL=shell.js.map