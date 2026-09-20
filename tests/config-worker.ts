import { saveConfig } from "../src/config.ts";

const marker = process.argv[2];
for (let index = 0; index < 8; index++) {
  await saveConfig({ enabled: true, provider: "fake", model: `${marker}-${index}` });
}
