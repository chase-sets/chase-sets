import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

acquireHeavySlot("build");
export default defineConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  build: {
    outDir: "build",
    rolldownOptions: { input: "product-cards.html" },
  },
  plugins: [tailwindcss(), viteSingleFile()],
});
