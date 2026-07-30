#!/usr/bin/env node
// Hub multi-origin lab rig (#67, hub track / D19).
//
// Serves packages/workbench/repro/ on TWO ports - two localhost ports are
// two distinct web origins, which is the whole point: both pages hold FSA
// grants on the same hub directory. Creates the hub dir (under $HOME -
// never /tmp, F9), raises the macOS notification at click time (the rig
// protocol in AGENTS.md), and stays up across Chrome restarts (the lab's
// phase C). Reports land in <hub>/probe/p<port>/r-*.json - watch those.
//
// Usage: node scripts/hub-lab.mjs [hub-dir]   (default ~/fsio-hub-lab)

import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(process.argv[2] ?? path.join(os.homedir(), "fsio-hub-lab"));
const PORTS = [8871, 8872];
const ROOT = fileURLToPath(new URL("../packages/workbench/repro/", import.meta.url));
const PAGE = "hub-multiorigin.html";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

await mkdir(HUB, { recursive: true });

const handler = async (req, res) => {
  const name = req.url === "/" ? PAGE : decodeURIComponent(req.url.slice(1)).split("?")[0];
  const file = path.normalize(path.join(ROOT, name));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
};

for (const port of PORTS) {
  http.createServer(handler).listen(port, "127.0.0.1");
}

console.log(`hub-lab up. hub: ${HUB}`);
for (const port of PORTS) console.log(`  origin ${port === PORTS[0] ? "A" : "B"}: http://localhost:${port}/`);
console.log(`reports: ${path.join(HUB, "probe", "p<port>", "r-*.json")}`);

if (process.platform === "darwin") {
  const s = `Pick ${HUB} on both pages - "Allow on every visit"`;
  spawn("osascript", ["-e", `display notification ${JSON.stringify(s)} with title "fsio rig" sound name "Glass"`], {
    stdio: "ignore", detached: true,
  }).unref();
}
