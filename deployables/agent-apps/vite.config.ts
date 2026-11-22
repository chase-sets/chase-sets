import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { addWidgetBundleHashes } from "./widget-csp";

// vite-plugin-singlefile inlines every chunk into every HTML input, so each widget is its own build.
const entries = ["product-cards", "cart-review", "checkout-handoff"];

acquireHeavySlot("build");
export default defineConfig(({ mode }) => {
  if (!entries.includes(mode)) throw new Error(`Build one Agent Apps widget with --mode ${entries.join("|")}.`);
  const input = `${mode}.html`;
  return {
    resolve: { alias: createWorkspaceSourceAliases() },
    build: {
      outDir: "build",
      // The widget builds share the output directory.
      emptyOutDir: false,
      rolldownOptions: { input },
    },
    plugins: [
      tailwindcss(),
      viteSingleFile(),
      {
        name: "widget-csp",
        enforce: "post",
        generateBundle: {
          order: "post",
          handler(_options, bundle) {
            const html = bundle[input];
            if (html?.type !== "asset" || typeof html.source !== "string") {
              this.error(`${input} bundle is missing.`);
            }
            html.source = addWidgetBundleHashes(html.source);
          },
        },
      },
    ],
  };
});
