import type { FetchFunction } from "@earendil-works/pi-ai";
import { SummaryModelError } from "./errors.ts";

// Bound a single SSE frame, never retain a response transcript. Oversized frames
// fail closed rather than silently losing the structured-refusal guarantee.
export const MAX_SSE_FRAME_CHARS = 1024 * 1024;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function refusalPart(value: unknown): boolean { return object(value)?.type === "refusal"; }
function refusalItem(value: unknown): boolean {
  const content = object(value)?.content;
  return Array.isArray(content) && content.some(refusalPart);
}
function isRefusal(value: unknown): boolean {
  const event = object(value);
  if (!event) return false;
  switch (event.type) {
    case "response.refusal.delta":
    case "response.refusal.done": return true;
    case "response.content_part.added":
    case "response.content_part.done": return refusalPart(event.part);
    case "response.output_item.added":
    case "response.output_item.done": return refusalItem(event.item);
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const output = object(event.response)?.output;
      return Array.isArray(output) && output.some(refusalItem);
    }
    default: return false;
  }
}

/** Incremental SSE inspection. Handles UTF-8, CR/LF/CRLF, multiline data and EOF. */
function inspector() {
  const decoder = new TextDecoder();
  let line = "", data: string[] = [], frameChars = 0, afterCR = false;
  function frame() {
    const json = data.join("\n").trim();
    data = []; frameChars = 0;
    if (!json || json === "[DONE]") return;
    let value: unknown;
    try { value = JSON.parse(json); }
    catch { throw new SummaryModelError("provider"); }
    if (isRefusal(value)) throw new SummaryModelError("refusal");
  }
  function endLine() {
    if (!line) frame();
    else if (line === "data" || line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    line = "";
  }
  function text(chunk: string) {
    for (const char of chunk) {
      if (afterCR && char === "\n") { afterCR = false; continue; }
      afterCR = char === "\r";
      if (++frameChars > MAX_SSE_FRAME_CHARS) throw new SummaryModelError("provider");
      if (char === "\r" || char === "\n") endLine();
      else line += char;
    }
  }
  return {
    push(bytes: Uint8Array) {
      // Decode bounded slices even when fetch supplies one very large chunk.
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        text(decoder.decode(bytes.subarray(offset, offset + 8192), { stream: true }));
      }
    },
    end() { text(decoder.decode()); if (line) endLine(); frame(); },
  };
}

/** Per-call public fetch hook: same request/auth/signal, byte-for-byte body forwarding.
 * Only Responses SSE is inspected. Providers that ignore fetch are outside this
 * guarantee. No tee/background promise can buffer a transcript or reject unseen.
 */
export function observeResponses(fetchImpl: FetchFunction = globalThis.fetch) {
  let failure: SummaryModelError | undefined;
  const fetch: FetchFunction = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const inspect = inspector();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let stopped = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const cancelReader = () => {
      // Cancellation errors must never create a secondary unhandled rejection.
      void reader.cancel().catch(() => {}).then(() => { reader.releaseLock(); }).catch(() => {});
    };
    const stop = (error: unknown) => {
      if (stopped) return;
      stopped = true; cleanup();
      if (error instanceof SummaryModelError) failure = error;
      controller.error(error);
      cancelReader();
    };
    const abort = () => stop(new SummaryModelError("aborted"));
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      },
      async pull() {
        if (stopped) return;
        try {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) {
            inspect.end();
            stopped = true; cleanup(); reader.releaseLock(); controller.close();
          } else {
            inspect.push(value);
            controller.enqueue(value);
          }
        } catch (error) { stop(error); }
      },
      cancel() {
        if (stopped) return;
        stopped = true; cleanup(); cancelReader();
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, check() { if (failure) throw failure; } };
}
