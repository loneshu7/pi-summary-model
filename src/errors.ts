export const messages = {
  setup: "Setup required. Use /summary-model select or /summary-model set <provider> <modelId>.",
  config: "Invalid summary-model.json in the global Pi agent directory. Repair or move that file, then run /summary-model set <provider> <modelId>.",
  storage: "Cannot read or save global summary-model.json. Check the Pi agent directory permissions and free disk space.",
  model: "Saved model is unavailable. Check exact IDs with /summary-model select or /summary-model set <provider> <modelId>.",
  auth: "Authentication is missing or failed. Use /login for the selected provider, then try again.",
  aborted: "Compaction cancelled. Run /compact when ready.",
  blank: "The provider returned an empty summary. Check the selected model with /summary-model status before trying again.",
  length: "The summary hit its output limit. Reduce the context or explicitly configure a model with a larger output limit using /summary-model set <provider> <modelId>.",
  tool: "The summary attempted a tool call. Check model compatibility with /summary-model status before trying again.",
  refusal: "The provider refused the summary request. Review the provider policy and the request before trying again.",
  rate: "The provider rate or quota limit was reached. Check the subscription or quota and try later.",
  provider: "The provider request failed. Check connectivity and provider availability; use /login if authentication expired, then try again.",
  unexpected: "Compaction could not complete. Check /summary-model status and the selected model configuration before trying again.",
  ui: "Model selection requires UI. Use /summary-model set <provider> <modelId>.",
  usage: "Usage: /summary-model status | select | set <provider> <modelId> | on | off",
} as const;
export type Failure = keyof typeof messages;
export class SummaryModelError extends Error {
  constructor(readonly category: Failure) { super(messages[category]); }
}
export function safeError(error: unknown): string {
  return messages[error instanceof SummaryModelError ? error.category : "unexpected"];
}
/** Classify internally; never include provider text in a diagnostic. */
export function providerError(error: unknown, status?: number): SummaryModelError {
  const text = (typeof error === "string" ? error : error instanceof Error ? error.message : "").slice(0, 4096);
  if (status === 401 || /unauthorized|authentication|api.?key|expired.*token|token.*expired|\b401\b/i.test(text)) return new SummaryModelError("auth");
  if (status === 403 || /refus|content.?filter|policy|\b403\b/i.test(text)) return new SummaryModelError("refusal");
  if (status === 429 || /rate.?limit|quota|\b429\b/i.test(text)) return new SummaryModelError("rate");
  return new SummaryModelError("provider");
}
