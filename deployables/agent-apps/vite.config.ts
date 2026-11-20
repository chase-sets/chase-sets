import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { addProductCardsBundleHashes } from "./product-cards-csp";

acquireHeavySlot("build");
export default defineConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  build: {
    outDir: "build",
    rolldownOptions: { input: "product-cards.html" },
  },
  plugins: [
    tailwindcss(),
    viteSingleFile(),
    {
      name: "product-cards-csp",
      enforce: "post",
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const html = bundle["product-cards.html"];
          if (html?.type !== "asset" || typeof html.source !== "string") {
            this.error("Product Cards HTML bundle is missing.");
          }
          html.source = addProductCardsBundleHashes(html.source);
        },
      },
    },
  ],
});
