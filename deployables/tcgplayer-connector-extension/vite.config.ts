import { resolve } from "node:path";
import { defineConfig } from "vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { extensionKeyCandidate } from "./src/authority-candidate";
import { createProbeManifestForKey } from "./src/manifest-contract";

const trustedPopupHtml =
  '<!doctype html><meta charset="utf-8"><title>Chromium authority probe</title><pre id="result">pending</pre><script type="module" src="popup.js"></script>\n';
const sandboxedPopupHtml =
  '<!doctype html><meta charset="utf-8"><title>Chromium sandbox authority probe</title><pre id="result">pending</pre><script type="module" src="popup-sandboxed.js"></script>\n';

export default defineConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        popup: resolve(import.meta.dirname, "src/popup.ts"),
        "popup-sandboxed": resolve(import.meta.dirname, "src/popup-sandboxed.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  plugins: [
    {
      name: "emit-chromium-authority-probe-assets",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: `${JSON.stringify(createProbeManifestForKey(extensionKeyCandidate), null, 2)}\n`,
        });
        this.emitFile({ type: "asset", fileName: "popup.html", source: trustedPopupHtml });
        this.emitFile({ type: "asset", fileName: "popup-sandboxed.html", source: sandboxedPopupHtml });
      },
    },
  ],
});
