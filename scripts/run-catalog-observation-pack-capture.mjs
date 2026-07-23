import { register } from "node:module";

register("./typescript-extension-loader.mjs", import.meta.url);
const { runCatalogObservationPackCli } = await import("./catalog-observation-pack-capture.ts");
process.exitCode = await runCatalogObservationPackCli();
