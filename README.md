# fsio

An experiment mashing together Web Platform FS API and stdio: a shared
directory acts as a pipe between a web page (File System Access API +
FileSystemObserver) and a native process. See `spec/PROTOCOL.md` for the
protocol draft and latency findings.

## Quickstart

```sh
# terminal 1: the host (native side)
node host/fsio-host.js ~/fsio-demo --allow-shell

# terminal 2: latency baseline without a browser
node bench/node-client.js ~/fsio-demo --count 500 --poll 5

# browser workbench (bench + xterm.js terminal)
npm run serve            # → http://localhost:8765/web/
# pick ~/fsio-demo, run the bench, or spawn a shell
```

Optional: `npm i node-pty` gives shell sessions a real pty (vim, colors,
resize). Without it, shells fall back to plain pipes.

## Layout

- `spec/PROTOCOL.md` — the living spec; the prototype is its workbench
- `common/frames.js` — frame encoding shared by host and clients
- `host/fsio-host.js` — native host: adopts sessions, echoes pings, spawns shells
- `web/` — browser client library + workbench page
- `bench/node-client.js` — node-only client for FS-transport baselines

## Headline numbers so far (macOS, APFS, Chrome 150)

- transport floor (node↔node): **p50 1.35 ms RTT** (1 ms polling)
- node client, shipping defaults: **p50 5.5 ms RTT**
- **browser ↔ host: p50 5.3 ms RTT** — via the "dirname fast lane" (payload
  encoded in created directory names, sidestepping Chrome's ~68 ms
  after-write scan on every file `close()`)
- key lessons: notification strategy, not the filesystem, is the latency
  budget; every file needs exactly one writer; and the browser's write path
  taxes file commits but not directory creation — see spec/PROTOCOL.md
  findings F1–F10
