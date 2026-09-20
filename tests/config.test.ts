import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { loadConfig, saveConfig } from "../src/config.ts";
import { harness, target } from "./helpers.ts";

const config = { enabled: true, provider: target.provider, model: target.id };
test("strict config roundtrip and atomic concurrent writes leave no temporary files", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  assert.equal(await loadConfig(), undefined);
  await saveConfig(config);
  assert.deepEqual(await loadConfig(), config);
  await Promise.all(Array.from({ length: 12 }, (_, i) => saveConfig({ ...config, enabled: i % 2 === 0 })));
  assert.equal(typeof (await loadConfig())?.enabled, "boolean");
  assert.deepEqual(await readdir(h.dir), ["summary-model.json"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(h.path, "utf8"))).sort(), ["enabled", "model", "provider"]);
});

for (const malformed of ["{", "null", "[]", "{}", JSON.stringify({ ...config, enabled: "true" }),
  JSON.stringify({ ...config, provider: " " }), JSON.stringify({ ...config, model: "bad\u001btext" }),
  JSON.stringify({ ...config, apiKey: "SECRET" }), JSON.stringify({ ...config, model: "" })]) {
  test(`invalid config is not overwritten (${malformed.slice(0, 45)})`, async (t) => {
    const h = await harness(); t.after(h.cleanup);
    await writeFile(h.path, malformed);
    await assert.rejects(loadConfig);
    await assert.rejects(() => saveConfig(config));
    for (const cmd of ["set openai-codex summary-exact", "off", "on", "select", "status"]) await h.command(cmd);
    assert.equal(await readFile(h.path, "utf8"), malformed);
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.doesNotMatch(h.notices.join(" "), /SECRET/);
  });
}

test("separate processes publish complete global configurations", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await saveConfig(config);
  const worker = fileURLToPath(new URL("./config-worker.ts", import.meta.url));
  const run = (marker: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, marker], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, PI_CODING_AGENT_DIR: h.dir }, stdio: "pipe",
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(Error(errorOutput)));
  });
  await Promise.all([run("first"), run("second"), run("third")]);
  const latest = await loadConfig();
  assert.equal(latest?.provider, "fake");
  assert.match(latest!.model, /^(first|second|third)-7$/);
  await h.command("status");
  assert.match(h.notices.at(-1)!, new RegExp(latest!.model));
  assert.deepEqual(await readdir(h.dir), ["summary-model.json"]);
});

test("unreadable config destination rejects writes and cancels compaction", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await saveConfig(config);
  // A directory at the destination is an ordinary I/O failure.
  const { unlink, mkdir } = await import("node:fs/promises");
  await unlink(h.path); await mkdir(h.path);
  await assert.rejects(() => saveConfig(config));
  assert.deepEqual(await readdir(h.dir), ["summary-model.json"]);
  assert.deepEqual(await h.compact(), { cancel: true });
});

test("commands set exact IDs, persist globally, show status and validate on/off", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command("on"); assert.equal(await loadConfig(), undefined);
  await h.command("set openai-codex SUMMARY-EXACT"); assert.equal(await loadConfig(), undefined);
  await h.command(`set ${target.provider} ${target.id}`); assert.deepEqual(await loadConfig(), config);
  await h.start(); assert.match(h.statuses.at(-1)!, /openai-codex\/summary-exact/);
  await h.command("status"); assert.match(h.notices.at(-1)!, /openai-codex\/summary-exact/);
  await h.command("off"); assert.deepEqual(await loadConfig(), { ...config, enabled: false });
  h.registry.hasConfiguredAuth = () => false;
  await h.command("on"); assert.equal((await loadConfig())?.enabled, false);
  assert.match(h.notices.at(-1)!, /\/login/);
  h.registry.hasConfiguredAuth = () => true;
  await h.command("on"); assert.equal((await loadConfig())?.enabled, true);
  for (const cmd of ["set", "set openai-codex", "set openai-codex summary-exact extra", "off extra", "unknown", "status extra"]) {
    await h.command(cmd); assert.deepEqual(await loadConfig(), config);
    assert.match(h.notices.at(-1)!, /Usage/);
  }
});

test("picker prefers openai-codex, cancellation leaves config untouched", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  await h.command("select"); assert.deepEqual(await loadConfig(), config);
  h.ui.select = async () => undefined;
  await h.command("select"); assert.deepEqual(await loadConfig(), config);
  assert.equal(h.registered.filter((name) => name === "summary-model").length, 1);
});

test("headless commands and hook errors use safe stderr and never invoke UI", async (t) => {
  const h = await harness(false); t.after(h.cleanup);
  h.ui.notify = () => { throw Error("UI unavailable"); };
  h.ui.setStatus = () => { throw Error("UI unavailable"); };
  h.ui.select = async () => { throw Error("UI unavailable"); };
  let output = "";
  t.mock.method(process.stderr, "write", (chunk: string) => { output += chunk; return true; });
  await h.command("select"); assert.match(output, /summary-model set/);
  assert.deepEqual(await h.compact(), { cancel: true });
  await h.command(`set ${target.provider} ${target.id}`);
  assert.deepEqual(await loadConfig(), config);
  await h.command("status"); assert.match(output, /openai-codex\/summary-exact/);
});

test("UI failure cannot make cancellation throw and fall back", async (t) => {
  const h = await harness(); t.after(h.cleanup);
  t.mock.method(process.stderr, "write", () => true);
  h.ui.notify = () => { throw Error("UI failure"); };
  h.ui.setStatus = () => { throw Error("UI failure"); };
  assert.deepEqual(await h.compact(), { cancel: true });
});
