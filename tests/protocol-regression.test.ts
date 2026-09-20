import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
// Exercise the installed providers; production uses only the public registry API.
import { streamSimple as codexStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import { streamSimple as responsesStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { event, harness, target } from "./helpers.ts";

const syntheticToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const item = (content: unknown[]) => ({ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content });
const added = { type: "response.output_item.added", output_index: 0, item: item([]) };
const completed = (content: unknown[]) => ({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item(content)] } });
const text = (value: string) => ({ type: "output_text", text: value, annotations: [] });
const refusal = { type: "refusal", refusal: "SECRET_REFUSAL provider policy" };
const success = [added, { type: "response.output_item.done", output_index: 0, item: item([text("Summary quoting policy and refusal; 中文")]) }, completed([text("Summary quoting policy and refusal; 中文")])];
const wire = (events: unknown[], eof = false) => events.map((value) => `data: ${JSON.stringify(value)}`).join("\n\n") + (eof ? "" : "\n\n");

async function localProvider(t: TestContext, replies: string[], api: "openai-responses" | "openai-codex-responses" = "openai-codex-responses", httpStatus = 200) {
  const h = await harness(); t.after(h.cleanup);
  let requests = 0, upgrades = 0;
  const server = createServer((request, response) => {
    request.resume();
    const body = replies[Math.min(requests++, replies.length - 1)];
    response.writeHead(httpStatus, { "content-type": "text/event-stream" });
    response.end(body);
  });
  // A real local WebSocket endpoint exposes the old provider's internal resend.
  server.on("upgrade", (request, socket) => {
    upgrades++;
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
    socket.on("data", (data: Buffer) => {
      if ((data[0] & 15) === 8) { socket.end(); return; }
      if ((data[0] & 15) !== 1) return;
      requests++;
      const payload = Buffer.from(JSON.stringify({ type: "error", code: "websocket_connection_limit_reached", message: "fixture" }));
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
    t.after(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const model: Model<Api> = { ...target, api, baseUrl: `http://127.0.0.1:${address.port}` };
  h.registry.find = () => model;
  h.registry.streamSimple = (selected, context, options) => {
    assert.equal(selected, model);
    assert.equal(options?.apiKey, undefined); // Auth is supplied at the registry boundary only.
    return api === "openai-codex-responses"
      ? codexStream(selected as Model<"openai-codex-responses">, normalizeContext(context), { ...options, apiKey: syntheticToken })
      : responsesStream(selected as Model<"openai-responses">, normalizeContext(context), { ...options, apiKey: syntheticToken });
  };
  await h.command(`set ${target.provider} ${target.id}`);
  return { h, counts: () => ({ requests, upgrades }) };
}

for (const api of ["openai-codex-responses", "openai-responses"] as const) {
  for (const [name, events, eof] of [
    ["delta", [added, { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "SECRET_REFUSAL" }, completed([refusal])], false],
    ["done", [added, { type: "response.refusal.done", output_index: 0, content_index: 0, refusal: "SECRET_REFUSAL" }, ...success.slice(1)], false],
    ["content part", [added, { type: "response.content_part.done", output_index: 0, content_index: 0, part: refusal }, ...success.slice(1)], false],
    ["output item", [added, { type: "response.output_item.done", output_index: 0, item: item([refusal]) }, completed([refusal])], false],
    ["final output at EOF", [added, success[1], completed([refusal])], true],
  ] as const) {
    test(`${api}: actual ${name} refusal cancels native compaction`, { timeout: 10000 }, async (t) => {
      const { h, counts } = await localProvider(t, [wire([...events], eof)], api);
      assert.deepEqual(await h.compact(), { cancel: true });
      assert.match(h.notices.at(-1)!, /refused/);
      assert.doesNotMatch(h.notices.at(-1)!, /SECRET_REFUSAL/);
      assert.deepEqual(counts(), { requests: 1, upgrades: 0 });
    });
  }
  test(`${api}: ordinary summary quoting refusal/policy words stays accepted`, { timeout: 10000 }, async (t) => {
    const { h, counts } = await localProvider(t, [wire(success)], api);
    const result = await h.compact();
    assert.ok(result?.compaction);
    assert.match(result.compaction.summary, /policy and refusal; 中文/);
    assert.deepEqual(counts(), { requests: 1, upgrades: 0 });
  });
}

test("real Codex error cannot cause a WebSocket resend or SSE fallback", { timeout: 10000 }, async (t) => {
  const { h, counts } = await localProvider(t, [wire([{ type: "error", code: "websocket_connection_limit_reached", message: "SECRET_ERROR" }])]);
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(counts(), { requests: 1, upgrades: 0 });
  assert.doesNotMatch(h.notices.at(-1)!, /SECRET_ERROR/);
});

test("real Codex HTTP 429 does not retry", { timeout: 10000 }, async (t) => {
  const { h, counts } = await localProvider(t, [JSON.stringify({ error: { message: "fixture rate limit" } })], "openai-codex-responses", 429);
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(counts(), { requests: 1, upgrades: 0 });
});

test("structured refusal on second native split request cancels the whole result", { timeout: 10000 }, async (t) => {
  const { h, counts } = await localProvider(t, [wire(success), wire([added, success[1], completed([refusal])], true)]);
  assert.deepEqual(await h.compact(event(true)), { cancel: true });
  assert.deepEqual(counts(), { requests: 2, upgrades: 0 });
  assert.match(h.notices.at(-1)!, /refused/);
});
