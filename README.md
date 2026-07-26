# fsio

An experiment mashing together Web Platform FS API and stdio: a shared
directory acts as a pipe between a web page (File System Access API +
FileSystemObserver) and a native process. See `spec/PROTOCOL.md` for the
protocol draft and `spec/FINDINGS.md` for the latency findings.

## Quickstart

```sh
npm install

# one command: fresh host on ~/fsio-demo + workbench server
scripts/dev.sh           # → http://localhost:8765/web/

# latency baseline without a browser (host must be running)
npm run bench -- ~/fsio-demo --count 500 --poll 5

# checks and the hermetic integration smoke test (same commands CI runs)
npm run check && npm test
```

Optional: `npm i node-pty` gives shell sessions a real pty (vim, colors,
resize). Without it, shells fall back to plain pipes.

## Layout

npm workspaces monorepo, orchestrated by [wireit](https://github.com/google/wireit)
(`npm run check` / `npm test` run the same dependency graph locally and in CI):

- `spec/PROTOCOL.md` — the normative spec; the prototype is its workbench
- `spec/FINDINGS.md` — measured platform behaviors (F1–F12), the lab notebook
- `spec/DECISIONS.md` — why the protocol is shaped this way (ADR-lite)
- `packages/common` — frame codec + JSON-RPC control plane (both sides import)
- `packages/host` — native host: adopts sessions, answers pings, spawns shells
- `packages/web` — browser client library + workbench page
- `packages/bench` — node bench clients + the protocol smoke test

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
