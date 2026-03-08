import { readFileSync } from "node:fs";

export const eventCorePostgresSchemaSql = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);
