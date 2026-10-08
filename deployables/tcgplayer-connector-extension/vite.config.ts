import { resolve } from "node:path";
import { defineConfig } from "vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { buildConnectorManifest } from "@chase-sets/channels";

export const manifestInput = {
  platformOrigin: process.env.VITE_PLATFORM_API_URL ?? process.env.PLATFORM_API_URL ?? "http://localhost:6182",
  hostRegistry: [],
  permissionRegistry: ["identity", "storage", "alarms"],
};

export default defineConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  define: {
    "import.meta.env.VITE_PLATFORM_API_URL": JSON.stringify(manifestInput.platformOrigin),
    "import.meta.env.VITE_CONNECTOR_CLIENT_ID": JSON.stringify(process.env.VITE_CONNECTOR_CLIENT_ID ?? ""),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: { background: resolve(import.meta.dirname, "src/background.ts") },
      output: { entryFileNames: "[name].js", inlineDynamicImports: true },
    },
  },
  plugins: [
    {
      name: "connector-closed-entry-graph",
      generateBundle(_options, bundle) {
        const worker = bundle["background.js"];
        if (
          Object.keys(bundle).join() !== "background.js" ||
          !worker ||
          worker.type !== "chunk" ||
          worker.imports.length ||
          worker.dynamicImports.length ||
          /\bnode:|\bimportScripts\s*\(|\bsetPopup\s*\(|\beval\s*\(|\bnew Function\s*\(/.test(worker.code)
        )
          throw new Error("connector-entry-graph-refused");
        const manifest = buildConnectorManifest(manifestInput);
        this.emitFile({ type: "asset", fileName: "manifest.json", source: `${JSON.stringify(manifest, null, 2)}\n` });
      },
    },
  ],
});
