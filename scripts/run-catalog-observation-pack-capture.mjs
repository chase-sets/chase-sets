import { register } from "node:module";

register("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
const { runCatalogObservationPackCli } = await import("./catalog-observation-pack-capture.ts");
process.exitCode = await runCatalogObservationPackCli();
