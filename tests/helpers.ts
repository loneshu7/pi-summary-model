import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

export const target: Model<Api> = {
  id: "summary-exact", provider: "openai-codex", name: "Summary", api: "openai-codex-responses",
  baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};
export const main: Model<Api> = { ...target, provider: "main-provider", id: "main-model" };
export function response(patch: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "Native summary" }], api: target.api,
    provider: target.provider, model: target.id, stopReason: "stop", timestamp: 1,
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } }, ...patch };
}
export function stream(message = response()) {
  const result = createAssistantMessageEventStream();
  result.push({ type: "start", partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    result.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    if (message.stopReason === "pending") throw new Error("pending is not a settled fake response");
    result.push({ type: "done", reason: message.stopReason, message });
  }
  return result;
}
export function preparation(split = false): SessionBeforeCompactEvent["preparation"] {
  return { firstKeptEntryId: "keep-uuid", tokensBefore: 4567,
    messagesToSummarize: [{ role: "user", content: "history fixture", timestamp: 1 }],
    turnPrefixMessages: split ? [{ role: "user", content: "split prefix fixture", timestamp: 2 }] : [],
    isSplitTurn: split, previousSummary: "Previous fixture summary",
    fileOps: { read: new Set(["old.ts", "changed.ts"]), edited: new Set(["changed.ts"]), written: new Set(["new.ts"]) },
    settings: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1000 } };
}
export function event(split = false): SessionBeforeCompactEvent {
  return { type: "session_before_compact", preparation: preparation(split), branchEntries: [],
    customInstructions: "Focus fixture", reason: "manual", willRetry: false, signal: new AbortController().signal };
}
export async function harness(hasUI = true) {
  const dir = await mkdtemp(join(tmpdir(), "pi-summary-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const notices: string[] = [];
  const statuses: string[] = [];
  const calls: { model: Model<Api>; context: Context; options?: ModelsSimpleStreamOptions }[] = [];
  const registry = {
    find: (provider: string, id: string) => provider === target.provider && id === target.id ? target : undefined,
    hasConfiguredAuth: (_model: Model<Api>) => true,
    getAvailable: () => [main, target],
    streamSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
      calls.push({ model, context, options });
      return stream();
    },
  };
  const ui = {
    notify: (message: string) => { notices.push(message); },
    setStatus: (_key: string, value: string) => { statuses.push(value); },
    select: async (_title: string, options: string[]): Promise<string | undefined> => options[0],
  };
  const ctx = { modelRegistry: registry, model: main, hasUI, ui, cwd: dir, thinkingLevel: "off" } as unknown as ExtensionCommandContext;
  let compactHook!: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | void>;
  let startHook!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const registered: string[] = [];
  const pi = {
    on: (name: string, handler: unknown) => {
      registered.push(name);
      if (name === "session_before_compact") compactHook = handler as typeof compactHook;
      if (name === "session_start") startHook = handler as typeof startHook;
    },
    registerCommand: (name: string, options: { handler: typeof command }) => {
      registered.push(name); command = options.handler;
    },
    setModel: () => { throw new Error("main model must never change"); },
  } as unknown as ExtensionAPI;
  extension(pi);
  return { dir, path: join(dir, "summary-model.json"), ctx, registry, ui, calls, notices, statuses, registered,
    compact: (input = event()) => compactHook(input, ctx),
    start: () => startHook({}, ctx),
    command: (args: string) => command(args, ctx),
    cleanup: async () => {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      await rm(dir, { recursive: true, force: true });
    } };
}
