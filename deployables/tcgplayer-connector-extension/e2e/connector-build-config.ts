import { resolve } from "node:path";
import { loadConfigFromFile } from "vite";

export async function loadConnectorBuildConfig(mode = "production") {
  const root = resolve(import.meta.dirname, "..");
  const loaded = await loadConfigFromFile(
    { command: "build", mode },
    resolve(root, "vite.config.ts"),
    root,
    "warn",
    undefined,
    "runner",
  );
  if (!loaded) throw new Error("connector-build-config-missing");
  return loaded.config;
}
