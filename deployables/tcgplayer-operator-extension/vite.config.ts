import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { operatorManifest } from "./src/manifest-contract";

acquireHeavySlot("build");
export default defineConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        popup: resolve(import.meta.dirname, "popup.html"),
        sandbox: resolve(import.meta.dirname, "sandbox.html"),
      },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js", assetFileNames: "[name][extname]" },
    },
  },
  plugins: [
    tailwindcss(),
    {
      name: "operator-extension-contract",
      generateBundle(_, bundle) {
        const modules = Object.values(bundle).flatMap((output) =>
          output.type === "chunk" ? Object.keys(output.modules) : [],
        );
        const forbidden = modules.filter(
          (id) =>
            id.includes("bounded-contexts/") &&
            !id.endsWith("catalog/client.ts") &&
            !id.includes("catalog/features/operator-session/domain/extension/") &&
            !id.includes("catalog/features/operator-session/ui/extension-popup/"),
        );
        if (forbidden.length)
          this.error(`Unexpected bounded-context runtime in operator extension: ${forbidden.join(", ")}`);
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: JSON.stringify(operatorManifest, null, 2) + "\n",
        });
      },
    },
  ],
});
