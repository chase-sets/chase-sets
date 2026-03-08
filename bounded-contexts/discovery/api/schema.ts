import { readFileSync } from "node:fs";

export const discoveryProjectionSchemaSql = readFileSync(
  new URL("./projections/schema.sql", import.meta.url),
  "utf8",
);
