import { register } from "node:module";

register("./typescript-extension-loader.mjs", import.meta.url);
await import("./catalog-production-completion-report.ts");
