# fsio

An experiment mashing together Web Platform FS API and stdio: a shared
directory acts as a pipe between a web page (File System Access API +
FileSystemObserver) and a native process. See `spec/PROTOCOL.md` for the
protocol draft and `spec/FINDINGS.md` for the latency findings.

## Quickstart

```sh
npm install

# one command: fresh host on ~/fsio-demo + workbench server
scripts/dev.sh           # → http://localhost:8765/

# latency baseline without a browser (host must be running)
npm run bench -- ~/fsio-demo --count 500 --poll 5

# checks and the hermetic integration smoke test (same commands CI runs)
npm run check && npm test
```

Optional: `npm i node-pty` gives shell sessions a real pty (vim, colors,
resize). Without it, shells fall back to plain pipes.

The hub daemon (in progress,
[#71](https://github.com/dglazkov/fsio/issues/71)) turns that one folder
into a socket and the folders you work in into named parameters:

```sh
npm run fsio -- share ~/code/myproject   # name it; the path stays here (D22)
npm run fsio -- workspaces
npm run fsiod                            # serve ~/fsio (Ctrl-C to stop)
```

`fsiod` refuses to spawn processes (`1007`) until the consent flow lands —
a grant is standing authority and the spawn policy is the per-request
judgment, and execution needs both
([D23](spec/DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities)).

## The demos

Two pages, two helpers, one shape: run a one-liner in the folder you want to
share, open the page, grant that folder. Nothing is uploaded and there is no
server in between — the page and the process talk through files in the folder
you picked (P1). Both helpers are macOS-only for now (confinement is
`sandbox-exec`); the pages run in any Chromium.

The `/acp` helper opens its page for you ([#124](https://github.com/dglazkov/fsio/issues/124)) —
it prints the URL first, resolves a Chromium rather than whatever your default
browser is (the page needs File System Access), and skips the tab entirely if
one is already open on that folder. `--no-open` prints and stops. What it
cannot do for you is the grant: picking the folder and allowing it twice are
Chrome's own gestures, unautomatable by design (F15), and they *are* the
security model.

```sh
# /terminal — a sandboxed shell over your working folder
npx github:dglazkov/fsio#terminal-demo

# /acp — a coding agent on your machine, driven from the page
npx github:dglazkov/fsio#acp-demo
```

Those branches are build output, not source: CI bundles each helper on every
green `main` and force-pushes it (`npm run -w @fsio/<demo> bundle`), so the
one-liner installs the same code the repo just tested. Both pages deploy to
Cloud Run on `v*` tags, each as its own service:

- [/terminal](https://terminal-demo.pewter.town)
- [/acp](https://agent-demo.pewter.town)

The `/acp` helper ships **no agent** ([#100](https://github.com/dglazkov/fsio/issues/100)):
vendoring an ACP adapter costs ~293 MB of transitive dependencies, and an
agent you installed is one you can also inspect, update and revoke. When it
finds none it offers to install one — a question in the terminal you are
already looking at, answered `y` or `n`, never a thing it decides for you —
into `~/.fsio/agents/<name>/`, which is off your PATH and comes back off in
one `rm -rf` it prints. It starts
without one anyway and publishes the roster it found — installed or not, and
crucially *whether each one asks permission before it edits*, which is the
thing this demo exists to show and which not every agent does. The page
renders that list and you choose from it
([D31](spec/DECISIONS.md#d31--a-kind-may-carry-embedder-detail-transcribed-never-interpreted-detected-by-presence)).

## Layout

npm workspaces monorepo, orchestrated by [wireit](https://github.com/google/wireit)
(`npm run check` / `npm test` run the same dependency graph locally and in CI):

- `spec/PROTOCOL.md` — the normative spec; the prototype is its workbench
- `spec/FINDINGS.md` — measured platform behaviors (F1–F12), the lab notebook
- `spec/DECISIONS.md` — why the protocol is shaped this way (ADR-lite)
- `spec/PRINCIPLES.md` — platform principles (P1–P6): what the platform refuses to trade away
- `packages/common` — frame codec + JSON-RPC control plane (both sides import)
- `packages/client` — client library: sessions over the shared dir (browser or Node, D11)
- `packages/host` — native host: adopts sessions, answers pings, spawns shells
- `packages/workbench` — measurement workbench page (consumes `@fsio/client`)
- `packages/bench` — node bench clients + protocol/lifecycle/client-conformance tests
- `packages/terminal-demo` — /terminal demo helper: sandboxed working-folder shell (consumes `@fsio/host`)
- `packages/acp-demo` — /acp demo: page + helper, a browser that is an ACP client driving a sandboxed local agent
- `packages/fsiod` — the hub daemon and the `fsio` CLI: one granted folder,
  many workspaces (also consumes `@fsio/host`)

## Headline numbers so far (macOS, APFS, Chrome 150)

- transport floor (node↔node): **p50 1.35 ms RTT** (1 ms polling)
- node client, shipping defaults: **p50 5.5 ms RTT**
- **browser ↔ host: p50 5.3 ms RTT** — via the "dirname fast lane" (payload
  encoded in created directory names, sidestepping Chrome's ~68 ms
  after-write scan on every file `close()`)
- key lessons: notification strategy, not the filesystem, is the latency
  budget; every file needs exactly one writer; and the browser's write path
  taxes file commits but not directory creation — see spec/FINDINGS.md
  (F1–F12)
