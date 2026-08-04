// The switchboard, without a folder under it. Everything here is about who
// gets an answer and who gets an error — the part of the demo that is
// logic rather than transport.
import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "./model.js";
import { ChannelError, Router, type PagePort } from "./router.js";
import type { Downstream } from "./messages.js";
import { receipt, refusal } from "./messages.js";

const fakePage = (id: string): { port: PagePort; sent: Downstream[] } => {
  const sent: Downstream[] = [];
  return { port: { id, send: (msg) => sent.push(msg) }, sent };
};

const commandId = (sent: Downstream[]): string => {
  const last = sent.at(-1);
  assert.ok(last && last.type === "command");
  return last.type === "command" ? last.id : "";
};

test("no page attached: dispatch fails before anything is sent", async () => {
  const router = new Router();
  assert.equal(router.attached, false);
  await assert.rejects(router.dispatch({ method: "tabs.list", params: {} }), (e: unknown) => {
    assert.ok(e instanceof ChannelError);
    assert.equal(e.reason, "no_page");
    return true;
  });
});

test("a command reaches the page and its receipt settles the promise", async () => {
  const router = new Router();
  const page = fakePage("s-1");
  router.attachPage(page.port);
  const pending = router.dispatch({ method: "tabs.add", params: { title: "Build", message: "x" } });

  assert.equal(page.sent.length, 1);
  const sent = page.sent[0]!;
  assert.equal(sent.type, "command");
  assert.equal(sent.type === "command" ? sent.method : "", "tabs.add");

  assert.equal(router.receipt(receipt(commandId(page.sent), { id: "tab-1" })), true);
  assert.deepEqual(await pending, { id: "tab-1" });
});

test("the page's refusal arrives as an AppError, hint and all", async () => {
  const router = new Router();
  const page = fakePage("s-1");
  router.attachPage(page.port);
  const pending = router.dispatch({ method: "tabs.remove", params: { id: "nope" } });
  router.receipt(refusal(commandId(page.sent), { code: "tab_not_found", message: "no tab", hint: "try list" }));
  await assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, "tab_not_found");
    assert.equal(e.hint, "try list");
    return true;
  });
});

test("a receipt nobody is waiting on is reported, not thrown", () => {
  const router = new Router();
  router.attachPage(fakePage("s-1").port);
  assert.equal(router.receipt(receipt("no-such-command", {})), false);
});

test("a second page displaces the first, which is told and loses its pending work", async () => {
  const router = new Router();
  const first = fakePage("s-1");
  const second = fakePage("s-2");
  router.attachPage(first.port);
  const pending = router.dispatch({ method: "tabs.list", params: {} });

  const { displaced } = router.attachPage(second.port);
  assert.equal(displaced, "s-1");
  assert.equal(first.sent.at(-1)?.type, "displaced");
  assert.equal(router.pageId, "s-2");
  await assert.rejects(pending, (e: unknown) => (e as ChannelError).reason === "page_gone");
});

test("a displaced page closing later does not detach its successor", () => {
  const router = new Router();
  router.attachPage(fakePage("s-1").port);
  router.attachPage(fakePage("s-2").port);
  assert.equal(router.detachPage("s-1"), false, "the old page's close is not the new page's");
  assert.equal(router.pageId, "s-2");
  assert.equal(router.detachPage("s-2"), true);
  assert.equal(router.attached, false);
});

test("the page closing mid-command fails the command rather than hanging it", async () => {
  const router = new Router();
  const page = fakePage("s-1");
  router.attachPage(page.port);
  const pending = router.dispatch({ method: "tabs.list", params: {} });
  router.detachPage("s-1");
  await assert.rejects(pending, (e: unknown) => (e as ChannelError).reason === "page_gone");
});

test("a page that never answers times out, and the timer does not outlive it", async () => {
  const router = new Router();
  router.attachPage(fakePage("s-1").port);
  await assert.rejects(router.dispatch({ method: "tabs.list", params: {} }, 20), (e: unknown) => {
    assert.ok(e instanceof ChannelError);
    assert.equal(e.reason, "timeout");
    return true;
  });
  // A late receipt for the timed-out command finds nothing waiting.
  assert.equal(router.receipt(receipt("c1", {})), false);
});
