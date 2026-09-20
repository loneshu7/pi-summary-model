import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// Test-only access: prepareCompaction is not exported at Pi's package root.
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { event, harness, main, response, stream, target } from "./helpers.ts";

for (const reason of ["manual", "threshold", "overflow"] as const) {
  test(`native compact preserves split summaries, metadata and usage (${reason})`, async (t) => {
    const h = await harness(); t.after(h.cleanup);
    await h.command(`set ${target.provider} ${target.id}`);
    const input = event(true); input.reason = reason;
    const result = await h.compact(input);
    assert.ok(result?.compaction);
    assert.equal(result.compaction.firstKeptEntryId, "keep-uuid");
    assert.equal(result.compaction.tokensBefore, 4567);
    assert.deepEqual(result.compaction.details, { readFiles: ["old.ts"], modifiedFiles: ["changed.ts", "new.ts"], summaryModelVersion: 1 });
    assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
    assert.match(result.compaction.summary, /<read-files>\nold.ts/);
    assert.match(result.compaction.summary, /<modified-files>\nchanged.ts\nnew.ts/);
    assert.equal(result.compaction.usage?.totalTokens, 38);
    assert.equal(result.compaction.usage?.cost.total, 0.66);
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) {
      assert.equal(call.model, target);
      assert.equal(call.options?.signal, input.signal);
      assert.equal(call.options?.maxRetries, 0);
      assert.equal(call.options?.transport, "sse");
      assert.equal(typeof call.options?.fetch, "function");
      assert.equal(call.options?.cacheRetention, "none");
      assert.ok(call.options?.sessionId);
      assert.equal(call.options?.apiKey, undefined);
    }
    assert.match(JSON.stringify(h.calls[0].context), /Previous fixture summary/);
    assert.match(JSON.stringify(h.calls[0].context), /Focus fixture/);
    assert.match(JSON.stringify(h.calls[1].context), /split prefix fixture/);
    assert.equal(h.ctx.model, main);
  });
}

const badResponses = {
  blank: response({ content: [{ type: "text", text: " \n\t" }] }),
  error: response({ stopReason: "error", errorMessage: "terminated SECRET_PROVIDER_PAYLOAD" }),
  length: response({ stopReason: "length" }),
  aborted: response({ stopReason: "aborted" }),
  tool: response({ content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] }),
  toolStop: response({ stopReason: "toolUse" }),
};
for (const [name, message] of Object.entries(badResponses)) {
  for (const badCall of [1, 2]) {
    test(`cancels ${name} response at split request ${badCall} without retry or fallback`, async (t) => {
      const h = await harness(); t.after(h.cleanup);
      await h.command(`set ${target.provider} ${target.id}`);
      let count = 0;
      h.registry.streamSimple = () => { count++; return stream(count === badCall ? message : response()); };
      assert.deepEqual(await h.compact(event(true)), { cancel: true });
      assert.equal(count, badCall);
      assert.equal(h.ctx.model, main);
      assert.ok(h.notices.at(-1)!.length < 600);
      assert.doesNotMatch(h.notices.at(-1)!, /SECRET_PROVIDER_PAYLOAD|terminated/);
    });
  }
}

test("repeated native preparation preserves this extension's cumulative file metadata", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command(`set ${target.provider} ${target.id}`);
  const first = await h.compact(); assert.ok(first?.compaction);
  const entries: SessionEntry[] = [
    { type: "message", id: "keep-uuid", parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "retained history", timestamp: 1 } },
    { type: "compaction", id: "compact-uuid", parentId: "keep-uuid", timestamp: "2026-01-01", ...first.compaction, fromHook: true },
    { type: "message", id: "recent-uuid", parentId: "compact-uuid", timestamp: "2026-01-01", message: { role: "user", content: "recent work remains", timestamp: 2 } },
  ];
  const prepared = prepareCompaction(entries, { enabled: true, reserveTokens: 8192, keepRecentTokens: 1 });
  assert.ok(prepared);
  assert.equal(prepared.fileOps.read.size, 0); // Native Pi skips fromHook details.
  const second = await h.compact({ ...event(), branchEntries: entries, preparation: prepared });
  assert.ok(second?.compaction);
  assert.deepEqual(second.compaction.details, first.compaction.details);
  assert.match(second.compaction.summary, /old.ts/);
  assert.equal(second.compaction.firstKeptEntryId, prepared.firstKeptEntryId);
  assert.equal(prepared.fileOps.read.size, 0); // Do not mutate the event shared by other hooks.
});

test("missing config cancels and explicit off permits native default", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.match(h.notices.at(-1)!, /summary-model (select|set)/);
  await h.command("off");
  assert.equal(await h.compact(), undefined);
  assert.equal(h.calls.length, 0);
});

for (const kind of ["missing-model", "missing-auth", "lookup-throws", "auth-throws", "stream-throws", "result-rejects"] as const) {
  test(`cancels ${kind} with safe actionable output`, async (t) => {
    const h = await harness(); t.after(h.cleanup);
    await h.command(`set ${target.provider} ${target.id}`);
    if (kind === "missing-model") h.registry.find = () => undefined;
    if (kind === "missing-auth") h.registry.hasConfiguredAuth = () => false;
    if (kind === "lookup-throws") h.registry.find = () => { throw Error("SECRET"); };
    if (kind === "auth-throws") h.registry.hasConfiguredAuth = () => { throw Error("SECRET"); };
    if (kind === "stream-throws") h.registry.streamSimple = () => { throw Error("SECRET"); };
    if (kind === "result-rejects") h.registry.streamSimple = () => {
      const result = stream(); result.result = async () => { throw Error("SECRET"); }; return result;
    };
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.doesNotMatch(h.notices.at(-1)!, /SECRET/);
    if (kind.includes("auth")) assert.match(h.notices.at(-1)!, /\/login/);
  });
}

test("abort before and during streaming cancels; signal reaches provider", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command(`set ${target.provider} ${target.id}`);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await h.compact({ ...event(), signal: controller.signal }), { cancel: true });
  assert.equal(h.calls.length, 0);
  const active = new AbortController();
  h.registry.streamSimple = (_model, _context, options) => {
    assert.equal(options?.signal, active.signal); active.abort(); return stream();
  };
  assert.deepEqual(await h.compact({ ...event(), signal: active.signal }), { cancel: true });
});

test("abort releases a compaction whose provider never settles", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command(`set ${target.provider} ${target.id}`);
  const controller = new AbortController();
  let started = false;
  h.registry.streamSimple = () => {
    started = true;
    const source = stream(); source.result = () => new Promise(() => {}); return source;
  };
  const result = h.compact({ ...event(), signal: controller.signal });
  while (!started) await setImmediate();
  controller.abort();
  assert.deepEqual(await result, { cancel: true });
});

for (const [status, expected] of [[401, /\/login/], [403, /policy/], [429, /quota/]] as const) {
  test(`provider status ${status} produces a bounded actionable category`, async (t) => {
    const h = await harness(); t.after(h.cleanup);
    await h.command(`set ${target.provider} ${target.id}`);
    let count = 0;
    h.registry.streamSimple = (_model, _context, options) => {
      count++;
      options?.onResponse?.({ status, headers: { authorization: "SECRET" } }, target);
      return stream(response({ stopReason: "error", errorMessage: "SECRET" }));
    };
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(count, 1);
    assert.match(h.notices.at(-1)!, expected);
    assert.doesNotMatch(h.notices.at(-1)!, /SECRET/);
  });
}

test("running compaction snapshots target; next hook reloads global config", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command(`set ${target.provider} ${target.id}`);
  const original = h.registry.streamSimple;
  let count = 0;
  h.registry.streamSimple = (model, context, options) => {
    const result = original(model, context, options);
    if (++count === 1) result.result = async () => { await h.command("off"); return response(); };
    return result;
  };
  assert.ok((await h.compact(event(true)))?.compaction);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.compact(), undefined);
});
