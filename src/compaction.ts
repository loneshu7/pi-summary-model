import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { compact, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SummaryModelConfig } from "./config.ts";
import { SummaryModelError, providerError } from "./errors.ts";

type Registry = ExtensionContext["modelRegistry"];
export function resolveTarget(config: SummaryModelConfig, registry: Registry) {
  if (!config.provider || !config.model) throw new SummaryModelError("setup");
  let model;
  try { model = registry.find(config.provider, config.model); }
  catch { throw new SummaryModelError("model"); }
  if (!model) throw new SummaryModelError("model");
  try {
    if (!registry.hasConfiguredAuth(model)) throw new SummaryModelError("auth");
  } catch { throw new SummaryModelError("auth"); }
  return model;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new SummaryModelError("aborted");
}
/** Stop waiting even if a custom provider ignores cancellation. The same signal reaches it. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SummaryModelError("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function validateResponse(message: AssistantMessage, signal: AbortSignal, status?: number): void {
  checkAbort(signal);
  if (message.stopReason === "aborted") throw new SummaryModelError("aborted");
  if (message.stopReason === "error") throw providerError(message.errorMessage, status);
  if (message.stopReason === "length") throw new SummaryModelError("length");
  if (message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")) throw new SummaryModelError("tool");
  if (message.stopReason !== "stop") throw new SummaryModelError("provider");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  if (!text.trim()) throw new SummaryModelError("blank");
}

function restoreFileMetadata(event: SessionBeforeCompactEvent): SessionBeforeCompactEvent["preparation"] {
  // Pi skips previous details when fromHook=true. Restore only our own versioned
  // native file lists, and clone the sets because other hooks share this event.
  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
  if (!previous || previous.type !== "compaction" || !previous.fromHook) return event.preparation;
  const details = previous.details as { summaryModelVersion?: unknown; readFiles?: unknown; modifiedFiles?: unknown } | undefined;
  if (details?.summaryModelVersion !== 1) return event.preparation;
  if (!Array.isArray(details.readFiles) || !details.readFiles.every((path) => typeof path === "string") ||
      !Array.isArray(details.modifiedFiles) || !details.modifiedFiles.every((path) => typeof path === "string")) throw new SummaryModelError("unexpected");
  const fileOps = event.preparation.fileOps;
  return { ...event.preparation, fileOps: {
    read: new Set([...fileOps.read, ...details.readFiles]),
    edited: new Set([...fileOps.edited, ...details.modifiedFiles]),
    written: new Set(fileOps.written),
  } };
}

export async function compactWithTarget(event: SessionBeforeCompactEvent, ctx: ExtensionContext, config: SummaryModelConfig) {
  checkAbort(event.signal);
  const model = resolveTarget(config, ctx.modelRegistry);
  const streamFn: NonNullable<Parameters<typeof compact>[7]> = async (_requestedModel, transcript, options) => {
    checkAbort(event.signal);
    let status: number | undefined;
    try {
      // TranscriptContext is already normalized, and its messages structurally satisfy
      // registry Context. Retain its system messages rather than rebuilding a prompt.
      // Registry owns request-time auth/OAuth refresh; do not resolve or inject credentials.
      const source = ctx.modelRegistry.streamSimple(model, { messages: transcript.messages }, {
        ...options, signal: event.signal, maxRetries: 0,
        onResponse: (response) => { status = response.status; },
      });
      const message = await abortable(source.result(), event.signal);
      validateResponse(message, event.signal, status);
      // compact() awaits result(). Only validated messages can cross this boundary.
      const validated = createAssistantMessageEventStream();
      validated.push({ type: "start", partial: message });
      validated.push({ type: "done", reason: "stop", message });
      return validated;
    } catch (error) {
      checkAbort(event.signal);
      if (error instanceof SummaryModelError) throw error;
      throw providerError(error, status);
    }
  };
  const result = await compact(restoreFileMetadata(event), model, undefined, undefined,
    event.customInstructions, event.signal, undefined, streamFn, undefined,
    { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 });
  checkAbort(event.signal);
  return { ...result, details: { ...(result.details as { readFiles: string[]; modifiedFiles: string[] }), summaryModelVersion: 1 } };
}
