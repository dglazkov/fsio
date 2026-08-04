#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ensureChannel } from "./queue.js";

const root = path.resolve(process.argv[2] ?? process.cwd());
fs.mkdirSync(root, { recursive: true });
const channel = ensureChannel(root);
console.log(`actuator demo helper`);
console.log(`workspace: ${root}`);
console.log(`channel:   ${channel}`);
console.log(`page:      http://localhost:8768/`);
console.log(`commands remain queued while the page is closed; press Ctrl-C to stop the helper`);
const heartbeat = path.join(channel, "helper.json");
const beat = () => fs.writeFileSync(heartbeat, `${JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() })}\n`);
beat();
const timer = setInterval(beat, 2000);
process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
