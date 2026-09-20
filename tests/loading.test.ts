import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { event, harness, target } from "./helpers.ts";

test("Pi 0.86.0 discovers the package manifest and loads its TypeScript extension", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Isolated cwd and agentDir prevent discovery of user extensions or credentials.
  const loaded = await discoverAndLoadExtensions([root], h.dir, h.dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.commands.keys()], ["summary-model"]);
  assert.deepEqual([...extension.handlers.keys()].sort(), ["session_before_compact", "session_start"]);
  await extension.commands.get("summary-model")!.handler(`set ${target.provider} ${target.id}`, h.ctx);
  const hook = extension.handlers.get("session_before_compact")![0];
  const result = await hook(event(true), h.ctx) as { compaction?: { firstKeptEntryId: string } };
  assert.equal(result.compaction?.firstKeptEntryId, "keep-uuid");
  assert.equal(h.calls.length, 2);
});
