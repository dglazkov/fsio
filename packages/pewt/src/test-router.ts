// The switchboard, with no host, no folder and no page.
//
// Everything here is about correlation and absence: a command reaching the
// page it was meant for, a receipt finding the command it answers, and the
// three ways an answer never arrives. The real session that carries them is
// test-loop.ts's business, and a browser's is the rig's.
import assert from "node:assert/strict";
import test from "node:test";
import { asReceipt, encodeControl, receipt, receiptError, type Command } from "pewter";
import { PageError, PageRefusal, Router } from "./router.js";

/** A page that records what it was sent and answers when told to. */
function fakePage(id = "s1"): { port: { id: string; send(msg: Command): void }; sent: Command[] } {
  const sent: Command[] = [];
  return { port: { id, send: (msg) => void sent.push(msg) }, sent };
}

test("a command reaches the attached page, and its receipt answers it", async () => {
  const router = new Router();
  const page = fakePage();
  router.attachPage(page.port);
  assert.equal(router.attached, true);
  assert.equal(router.pageId, "s1");

  const answer = router.dispatch("tabs.add", { name: "repos" });
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0]!.method, "tabs.add");
  assert.deepEqual(page.sent[0]!.params, { name: "repos" });

  // Round-tripped through the codec rather than handed back as an object: the
  // frame is what actually travels, and a receipt this build cannot read is
  // the failure worth catching here.
  router.receipt(asReceipt(encodeControl(receipt(page.sent[0]!.id, { id: "tab-1" })))!);
  assert.deepEqual(await answer, { id: "tab-1" });
});

test("the page saying no is not the channel failing", async () => {
  const router = new Router();
  const page = fakePage();
  router.attachPage(page.port);
  const answer = router.dispatch("tabs.focus", { id: "tab-9" });
  router.receipt(receiptError(page.sent[0]!.id, { code: "tab_not_found", message: "no tab with id \"tab-9\"", hint: "run `pewt tabs`" }));
  await assert.rejects(
    () => answer,
    (e: unknown) => e instanceof PageRefusal && e.code === "tab_not_found" && !!e.hint
  );
});

test("with no page attached, nothing is sent and the reason says what to do", async () => {
  const router = new Router();
  await assert.rejects(
    () => router.dispatch("tabs.list", {}),
    (e: unknown) => e instanceof PageError && e.reason === "no_page" && /drop this folder/.test(e.hint ?? "")
  );
});

test("a page that goes fails what was waiting on it, rather than making it wait", async () => {
  const router = new Router();
  const page = fakePage();
  router.attachPage(page.port);
  const answer = router.dispatch("tabs.list", {});
  assert.equal(router.detachPage("s1"), true);
  await assert.rejects(() => answer, (e: unknown) => e instanceof PageError && e.reason === "page_gone");
  assert.equal(router.attached, false);
});

test("a displaced page loses the commands it had not answered", async () => {
  const router = new Router();
  const first = fakePage("s1");
  const second = fakePage("s2");
  router.attachPage(first.port);
  const answer = router.dispatch("tabs.list", {});
  const { displaced } = router.attachPage(second.port);
  assert.equal(displaced, "s1");
  await assert.rejects(() => answer, (e: unknown) => e instanceof PageError && e.reason === "page_gone");
  // The page that left later must not clear the one that took its place.
  assert.equal(router.detachPage("s1"), false);
  assert.equal(router.pageId, "s2");
});

test("a page that does not answer in time is a failure, not a hang", async () => {
  const router = new Router();
  router.attachPage(fakePage().port);
  await assert.rejects(
    () => router.dispatch("tabs.list", {}, 20),
    // F16: a hidden tab beats about once a minute, so this is a live outcome
    // rather than a theoretical one, and the hint has to say both readings.
    (e: unknown) => e instanceof PageError && e.reason === "timeout" && /background/.test(e.hint ?? "")
  );
});

test("a receipt nobody is waiting for is dropped, not thrown over", () => {
  const router = new Router();
  router.attachPage(fakePage().port);
  assert.equal(router.receipt(receipt("c99", { id: "tab-1" })), false);
});

test("a frame this build cannot read is not a receipt", () => {
  assert.equal(asReceipt("not json"), null);
  assert.equal(asReceipt(JSON.stringify({ v: 1, type: "pewt:receipt" })), null);
  assert.equal(asReceipt(JSON.stringify({ v: 99, type: "pewt:receipt", id: "c1", ok: true, result: {} })), null);
});

test("the host shutting down answers everything it was holding", async () => {
  const router = new Router();
  router.attachPage(fakePage().port);
  const answer = router.dispatch("tabs.list", {});
  router.close();
  await assert.rejects(() => answer, (e: unknown) => e instanceof PageError && e.reason === "page_gone");
});
