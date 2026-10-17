import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findBootSchemaLedgerConvergenceViolations,
  findBootSchemaRetainedUpgradeViolations,
} from "./boot-schema-ddl-discipline.mjs";

const source = readFileSync(
  new URL("../../bounded-contexts/pricing/features/repricing-engine/read-model/schema.ts", import.meta.url),
  "utf8",
);
const baseSource = `export const pricingRepricingEngineSchemaSql = \`
CREATE TABLE IF NOT EXISTS pricing_repricing_product_round_cooldowns (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  next_eligible_at timestamptz NOT NULL,
  last_trigger_event_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);
\`;`;
const columns = ["frozen_until", "last_direction", "same_direction_rounds", "tripped_at"];

describe("repricing spiral breaker schema class guard", () => {
  it("requires all four boot and ledger expansions independent of ambient changed-file scope", () => {
    // Explicit source inputs deliberately avoid CHANGED_FILES_JSON and Git scope inference.
    expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource: source })).toEqual([]);
    expect(findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource: source })).toEqual([]);
    const withoutLedger = source.slice(0, source.indexOf("export const pricingRepricingEngineSchemaMigrations"));
    expect(
      findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource: withoutLedger })
        .map((violation) => violation.columnName)
        .sort(),
    ).toEqual(columns);
    const withoutBootExpansion = source.replace(/ALTER TABLE pricing_repricing_product_round_cooldowns[\s\S]*?;/, "");
    expect(
      findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource: withoutBootExpansion })
        .map((violation) => violation.columnName)
        .sort(),
    ).toEqual(columns);
    expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource: withoutBootExpansion })).toEqual([]);
  });
});
