import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, validId, type SummaryModelConfig } from "./config.ts";
import { compactWithTarget, resolveTarget } from "./compaction.ts";
import { SummaryModelError, safeError } from "./errors.ts";

function notify(ctx: ExtensionContext, message: string, type: "info" | "error" = "info"): void {
  try { if (ctx.hasUI) { ctx.ui.notify(message, type); return; } } catch { /* stderr fallback */ }
  try { process.stderr.write(`[summary-model] ${message}\n`); } catch { /* reporting must not enable fallback */ }
}
function route(config: SummaryModelConfig | undefined): string {
  if (!config) return "Summary model: setup required";
  if (!config.enabled) return `Summary model: off (default Pi compaction)${config.provider ? `; saved ${config.provider}/${config.model}` : ""}`;
  return `Summary model: ${config.provider}/${config.model}`;
}
function setStatus(ctx: ExtensionContext, text: string): void {
  try { if (ctx.hasUI) ctx.ui.setStatus("summary-model", text); } catch { /* optional display */ }
}
export default function summaryModel(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try { setStatus(ctx, route(await loadConfig())); }
    catch (error) { setStatus(ctx, "Summary model: config error"); notify(ctx, safeError(error), "error"); }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const config = await loadConfig();
      setStatus(ctx, route(config));
      if (!config) throw new SummaryModelError("setup");
      if (!config.enabled) return;
      return { compaction: await compactWithTarget(event, ctx, config) };
    } catch (error) {
      notify(ctx, `Compaction stopped. ${safeError(error)}`, "error");
      // Pi catches thrown extension errors and continues: always explicitly cancel.
      return { cancel: true };
    }
  });
  pi.registerCommand("summary-model", {
    description: "Configure global compaction model: status, select, set <provider> <modelId>, on, off",
    handler: async (args, ctx) => {
      try {
        const saved = await loadConfig();
        const words = args.trim() ? args.trim().split(/\s+/) : ["status"];
        const [action, provider, model] = words;
        let next: SummaryModelConfig;
        if (action === "set" && words.length === 3) {
          if (!validId(provider) || !validId(model)) throw new SummaryModelError("usage");
          next = { enabled: true, provider, model };
          resolveTarget(next, ctx.modelRegistry);
        } else if (words.length !== 1) {
          throw new SummaryModelError("usage");
        } else if (action === "status") {
          setStatus(ctx, route(saved));
          notify(ctx, saved ? route(saved) : `${route(saved)}. Use /summary-model select or /summary-model set <provider> <modelId>.`);
          return;
        } else if (action === "off") {
          next = { enabled: false, provider: saved?.provider ?? "", model: saved?.model ?? "" };
        } else if (action === "on") {
          if (!saved) throw new SummaryModelError("setup");
          next = { ...saved, enabled: true };
          resolveTarget(next, ctx.modelRegistry);
        } else if (action === "select") {
          if (!ctx.hasUI) throw new SummaryModelError("ui");
          const available = ctx.modelRegistry.getAvailable()
            .filter((entry) => validId(entry.provider) && validId(entry.id))
            .sort((a, b) => Number(b.provider === "openai-codex") - Number(a.provider === "openai-codex") || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
          if (available.length === 0) throw new SummaryModelError("auth");
          // Numbered labels avoid ambiguity when a provider or model ID contains '/'.
          const choices = available.map((entry, index) => `${index + 1}. ${entry.provider}/${entry.id}`);
          const choice = await ctx.ui.select("Global summary model", choices);
          if (choice === undefined) return;
          const selected = available[choices.indexOf(choice)];
          if (!selected) throw new SummaryModelError("model");
          next = { enabled: true, provider: selected.provider, model: selected.id };
          resolveTarget(next, ctx.modelRegistry);
        } else {
          throw new SummaryModelError("usage");
        }
        await saveConfig(next);
        setStatus(ctx, route(next));
        notify(ctx, `${route(next)}. Saved globally; applies to the next compaction.`);
      } catch (error) {
        notify(ctx, safeError(error), "error");
      }
    },
  });
}
