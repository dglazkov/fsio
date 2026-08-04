import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Command } from "./model.js";
import { atomicJson, cancel, channelDir, enqueue, getStatus } from "./queue.js";

test("commands remain pending until the page writes a result (#152)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actuator-queue-"));
  const command: Command = { id: "cmd-one", createdAt: new Date().toISOString(), method: "tabs.list", params: {} };
  enqueue(root, command);
  assert.equal(getStatus(root, command.id)?.status, "pending");
  atomicJson(path.join(channelDir(root), "results", "cmd-one.json"), { commandId: "cmd-one", status: "applied", completedAt: new Date().toISOString(), result: { tabs: [] } });
  assert.equal(getStatus(root, command.id)?.status, "applied");
  fs.rmSync(root, { recursive: true });
});

test("cancellation is a separate one-writer file (#152)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actuator-cancel-"));
  enqueue(root, { id: "cmd-two", createdAt: new Date().toISOString(), method: "tabs.list", params: {} });
  assert.equal(cancel(root, "cmd-two").status, "cancelled");
  fs.rmSync(root, { recursive: true });
});
