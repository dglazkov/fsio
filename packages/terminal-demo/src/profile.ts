// The sandbox-exec (Seatbelt/SBPL) profile for terminal-demo shells.
//
// This string IS the security posture of the demo (#16 decision ledger):
// review it like protocol code. It ships as source, and the helper also
// writes it to `<shared-dir>/.fsio/sandbox.sb` at startup so a user can
// inspect exactly what their shell can do, from inside the shared folder.
//
// SBPL semantics: the LAST matching rule wins, so order below is
// meaningful — broad allow, then the write clampdown, then the re-allows,
// then the final `.fsio` deny that must override the ROOT allow (D6: one
// writer per file; the transport must be protected from its own payload).
// test-sandbox.ts asserts each layer, including the last-match-wins
// assumption itself.
//
// Parameters (passed by sandbox.ts via `-D`, all realpath'd — Seatbelt
// matches kernel-real paths, so `/var/…` symlinks must be resolved):
//   ROOT — the shared directory (the folder the browser picked)
//   FSIO — ROOT/.fsio (the protocol area)
//   TMP  — the user temp dir (os.tmpdir(); shells and tools break without it)
export const SANDBOX_PROFILE = `(version 1)

;; terminal-demo shell sandbox (fsio #16).
;; Posture: read the world, write only the shared folder — minus the
;; protocol's own .fsio area — plus the scratch space a shell needs to
;; be usable. Network is deliberately allowed (working-folder use:
;; git pull, npm install).

;; Everything not about writing files: allowed (process-exec, network,
;; file-read*, signals, ...). The demo's threat model is "a remote page
;; drives a local shell"; the wall we hold is what that shell can MODIFY.
(allow default)

;; The wall: no file writes anywhere...
(deny file-write*)

;; ...except the shared folder itself (the thing the user consciously
;; granted to the browser — granting it to the shell is the symmetry
;; the demo wants to demonstrate),
(allow file-write* (subpath (param "ROOT")))

;; ...the user temp dir plus /tmp (shells, git, editors and installers
;; assume a writable TMPDIR; some tools hardcode /tmp),
(allow file-write* (subpath (param "TMP")))
(allow file-write* (subpath "/private/tmp"))

;; ...and the devices an interactive shell touches (its own pty, the
;; bit bucket).
(allow file-write* (literal "/dev/null"))
(allow file-write* (regex #"^/dev/tty"))

;; Final word (last match wins): the protocol area inside ROOT stays
;; host-owned even though ROOT is writable. A shell that could edit
;; .fsio could corrupt or spoof its own transport (D6).
(deny file-write* (subpath (param "FSIO")))
`;
