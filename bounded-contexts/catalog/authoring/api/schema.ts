import { readFileSync } from "node:fs";

export const catalogAuthoringProjectionSchemaSql = readFileSync(
  new URL("./projections/schema.sql", import.meta.url),
  "utf8",
);
