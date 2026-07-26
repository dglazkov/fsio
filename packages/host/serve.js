#!/usr/bin/env node
// Tiny static server for the web workbench (secure-context APIs need http://localhost).
// Usage: node host/serve.js [port]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.argv[2] ?? 8765);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // Monorepo layout, stable URLs: /web/ and /common/ live under packages/.
    p = p.replace(/^\/(web|common)\//, "/packages/$1/");
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store", // stale HTML+fresh JS = silent breakage
      });
      res.end(data);
    });
  })
  .listen(port, () => {
    console.log(`fsio workbench: http://localhost:${port}/web/`);
  });
