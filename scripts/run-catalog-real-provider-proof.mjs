import { register } from "node:module";

register("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
await import("./catalog-real-provider-proof.ts");
