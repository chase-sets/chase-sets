import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listSourceObservationIdsForPromotion } from "../read-model/queries";
import { parsePromotionScope } from "./route-modules/route-helpers";
import { isExplicitBulkJobScope, normalizeBulkJobScope } from "./source-observation-job-serialization";

// Synthetic observations only: one inside each coordinate, one outside it.
const observations = [
  { observation_id: "synthetic-in-scope", productLineId: "synthetic-line", seriesId: "synthetic-series" },
  {
    observation_id: "synthetic-outside-scope",
    productLineId: "synthetic-other-line",
    seriesId: "synthetic-other-series",
  },
];

function selectingQueryable() {
  return {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      const rows = observations.filter(
        (row) =>
          (!sql.includes("normalized->>'seriesId' = $") || values.includes(row.seriesId)) &&
          (!sql.includes("normalized->>'productLineId'") || values.includes(row.productLineId)),
      );
      return { rows: rows.map(({ observation_id }) => ({ observation_id })) };
    }),
  } as unknown as PgQueryable & { query: ReturnType<typeof vi.fn> };
}

describe("bulk review job scope", () => {
  it.each([
    ["seriesId", { seriesId: " synthetic-series " }, "normalized->>'seriesId' = $1", "synthetic-series"],
    ["productLineId", { productLineId: "synthetic-line" }, "normalized->>'productLineId'", "synthetic-line"],
  ] as const)(
    "keeps a %s coordinate through the job scope and selects only inside it",
    async (field, input, predicate, value) => {
      const scope = normalizeBulkJobScope(parsePromotionScope(input));

      expect(scope[field]).toBe(value);
      expect(isExplicitBulkJobScope(scope)).toBe(true);

      const db = selectingQueryable();
      await expect(listSourceObservationIdsForPromotion(db, scope)).resolves.toEqual(["synthetic-in-scope"]);
      const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(predicate);
      expect(values).toContain(value);
    },
  );

  it("keeps the expansion alias as the set coordinate", () => {
    expect(normalizeBulkJobScope({ expansionId: "synthetic-set" }).setId).toBe("synthetic-set");
    expect(normalizeBulkJobScope({ setId: "synthetic-set" }).setId).toBe("synthetic-set");
    expect(normalizeBulkJobScope({ expansionId: "synthetic-expansion", setId: "synthetic-set" }).setId).toBe(
      "synthetic-expansion",
    );
  });

  it.each([{}, { provider: "   " }, { unknown: "synthetic" }, "synthetic", null])("treats %j as no scope", (input) => {
    expect(isExplicitBulkJobScope(parsePromotionScope(input))).toBe(false);
  });
});
