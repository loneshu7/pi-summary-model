import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SummaryModelError } from "./errors.ts";

export interface SummaryModelConfig { enabled: boolean; provider: string; model: string }
export const configPath = () => join(getAgentDir(), "summary-model.json");
// Keep exact IDs, including slashes; reject whitespace and terminal controls.
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\p{Cc}\p{Cf}]/u.test(value);
}
export function validateConfig(value: unknown): SummaryModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SummaryModelError("config");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "enabled,model,provider" || typeof data.enabled !== "boolean") throw new SummaryModelError("config");
  // Explicit off before setup needs a durable opt-out without inventing model IDs.
  const unconfiguredOff = data.enabled === false && data.provider === "" && data.model === "";
  if (!unconfiguredOff && (!validId(data.provider) || !validId(data.model))) throw new SummaryModelError("config");
  return { enabled: data.enabled, provider: data.provider as string, model: data.model as string };
}
async function readConfig(path: string): Promise<SummaryModelConfig | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SummaryModelError("storage");
  }
  try { return validateConfig(JSON.parse(text)); }
  catch { throw new SummaryModelError("config"); }
}
export function loadConfig(): Promise<SummaryModelConfig | undefined> { return readConfig(configPath()); }

/** Readers see a complete old or new config. Concurrent successful writes are last-writer-wins. */
export async function saveConfig(value: SummaryModelConfig): Promise<void> {
  const config = validateConfig(value);
  const path = configPath();
  await readConfig(path); // Never silently replace malformed configuration.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    // Windows can transiently deny replacement while another process has the old
    // file open. Retry publication only, never a model request or a partial write.
    for (let attempt = 0; ; attempt++) {
      await readConfig(path);
      try { await rename(temporary, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 8 || !["EACCES", "EPERM", "EBUSY"].includes(code ?? "")) throw error;
        await delay(10 * (attempt + 1));
      }
    }
  } catch (error) {
    if (error instanceof SummaryModelError) throw error;
    throw new SummaryModelError("storage");
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
