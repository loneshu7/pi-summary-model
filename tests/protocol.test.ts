import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SSE_FRAME_CHARS, observeResponses } from "../src/protocol.ts";
import { SummaryModelError } from "../src/errors.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const category = (expected: string) => (error: unknown) => error instanceof SummaryModelError && error.category === expected;
function source(chunks: Uint8Array[], options: { hang?: boolean; rejectCancel?: boolean } = {}) {
  let reads = 0, cancels = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (!options.hang) controller.close();
    },
    cancel() { cancels++; if (options.rejectCancel) throw Error("SECRET_CANCEL"); },
  }, { highWaterMark: 0 }), { status: 201, statusText: "Created", headers: { "content-type": "text/event-stream", "x-fixture": "preserved" } });
  return { response, counts: () => ({ reads, cancels }) };
}

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`SSE ${JSON.stringify(newline)} split at every byte preserves bytes, status, headers and request`, async () => {
    const bytes = encode([": comment", "event: response.output_text.delta", 'data: {"type":"response.output_text.delta",', 'data: "delta":"中文 policy refusal {\\"type\\":\\"refusal\\"}"}', "", "data: [DONE]", "", ""].join(newline));
    const upstream = source(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    const request = new Request("https://invalid.example/fixture");
    const init = { method: "POST", body: "fixture", headers: { "x-fixture": "request" }, signal: new AbortController().signal };
    const observer = observeResponses(async (actual, actualInit) => {
      assert.equal(actual, request); assert.equal(actualInit, init);
      return upstream.response;
    });
    const response = await observer.fetch(request, init);
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.deepEqual([...response.headers], [...upstream.response.headers]);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    observer.check();
  });
}

for (const ending of ["\n\n", "\r\n\r\n", "\r\r", ""]) {
  test(`structured refusal with ${JSON.stringify(ending)} ending is caught across single-byte chunks`, async () => {
    const bytes = encode('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"refusal","refusal":"中文 SECRET"}]}]}}' + ending);
    const upstream = source(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    const observer = observeResponses(async () => upstream.response);
    const response = await observer.fetch("https://invalid.example");
    await assert.rejects(response.text(), category("refusal"));
    assert.throws(observer.check, category("refusal"));
  });
}

test("refusal promptly cancels an open network reader, including a rejecting cancel", async () => {
  const upstream = source([encode('data: {"type":"response.refusal.delta","delta":"SECRET"}\n\n')], { hang: true, rejectCancel: true });
  const observer = observeResponses(async () => upstream.response);
  const response = await observer.fetch("https://invalid.example");
  await assert.rejects(response.text(), category("refusal"));
  assert.deepEqual(upstream.counts(), { reads: 1, cancels: 1 });
  assert.throws(observer.check, category("refusal"));
});

test("abort interrupts a pending read and cancels the upstream body", async () => {
  const upstream = source([], { hang: true });
  const controller = new AbortController();
  const observer = observeResponses(async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return upstream.response;
  });
  const response = await observer.fetch("https://invalid.example", { signal: controller.signal });
  const pending = response.text();
  controller.abort();
  await assert.rejects(pending, category("aborted"));
  assert.equal(upstream.counts().cancels, 1);
});

test("an already aborted Request signal cancels before reading", async () => {
  const controller = new AbortController(); controller.abort();
  const upstream = source([], { hang: true });
  const observer = observeResponses(async () => upstream.response);
  const response = await observer.fetch(new Request("https://invalid.example", { signal: controller.signal }));
  await assert.rejects(response.text(), category("aborted"));
  assert.deepEqual(upstream.counts(), { reads: 0, cancels: 1 });
});

test("downstream cancellation cancels upstream without reading ahead", async () => {
  const upstream = source([encode(': fixture\n\n')], { hang: true, rejectCancel: true });
  const observer = observeResponses(async () => upstream.response);
  const response = await observer.fetch("https://invalid.example");
  assert.equal(upstream.counts().reads, 0);
  const reader = response.body!.getReader();
  await reader.read(); await reader.cancel();
  assert.deepEqual(upstream.counts(), { reads: 1, cancels: 1 });
});

test("oversized SSE frame fails closed with bounded error and cancels reader", async () => {
  const upstream = source([encode('data: {"type":"response.output_text.delta","delta":"' + "x".repeat(MAX_SSE_FRAME_CHARS))], { hang: true });
  const observer = observeResponses(async () => upstream.response);
  const response = await observer.fetch("https://invalid.example");
  await assert.rejects(response.text(), category("provider"));
  assert.throws(observer.check, category("provider"));
  assert.equal(upstream.counts().cancels, 1);
});

test("frame bound resets between events without accumulating a transcript", async () => {
  const frame = encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(8192) })}\n\n`);
  const count = Math.ceil(MAX_SSE_FRAME_CHARS / frame.length) + 5;
  const upstream = source(Array.from({ length: count }, () => frame));
  const observer = observeResponses(async () => upstream.response);
  const response = await observer.fetch("https://invalid.example");
  const reader = response.body!.getReader();
  let received = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; received += chunk.value.length; }
  assert.equal(received, count * frame.length);
  observer.check();
});

test("malformed SSE JSON fails closed without echoing payload", async () => {
  const upstream = source([encode('data: SECRET_INVALID\n\n')]);
  const observer = observeResponses(async () => upstream.response);
  await assert.rejects((await observer.fetch("https://invalid.example")).text(), category("provider"));
  try { observer.check(); assert.fail("expected protocol failure"); }
  catch (error) { assert.doesNotMatch(String(error), /SECRET_INVALID/); }
});

test("HTTP errors pass through untouched for the existing provider status handling", async () => {
  const upstream = new Response('fixture rate limit', { status: 429, headers: { "retry-after": "1" } });
  const observer = observeResponses(async () => upstream);
  assert.equal(await observer.fetch("https://invalid.example"), upstream);
  observer.check();
});
