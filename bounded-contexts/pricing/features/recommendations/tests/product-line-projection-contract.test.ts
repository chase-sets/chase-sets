import { describe, expect, it, vi } from "vitest";
import { buildPricingCatalogInputProjectionHandlers } from "../integrations/source/source-projection";

const recordedAt = "2026-10-16T00:00:01.000Z";
const fieldEvent = (data: Record<string, unknown>) =>
  ({
    streamId: "catalog.item-synthetic-item",
    streamVersion: 2,
    timing: { recordedAt },
    data,
  }) as never;

describe("Product Line projection SQL contracts", () => {
  it("increments only tuple changes with event time in one set-based refresh", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handlers = buildPricingCatalogInputProjectionHandlers({ query });
    await handlers["catalog.catalog-item.field-value-set"]!(
      fieldEvent({ fieldId: "field", value: { referenceId: "line" } }),
    );
    const refresh = query.mock.calls.find(([sql]) => sql.includes("UPDATE pricing_catalog_item_inputs"));
    expect(refresh?.[0]).toContain("COALESCE(item.product_line_version, 0) + 1");
    expect(refresh?.[0]).toContain("IS DISTINCT FROM (resolved.reference_id, resolved.name)");
    expect(refresh?.[0]).not.toMatch(/now\(\)|GREATEST/);
    expect(refresh?.[1]).toContain(recordedAt);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["field-value-cleared", "field-value-set"])(
    "retains a version-fenced null tombstone for %s",
    async (kind) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const handlers = buildPricingCatalogInputProjectionHandlers({ query });
      await handlers[`catalog.catalog-item.${kind}`]!(fieldEvent({ fieldId: "field", value: "not a reference" }));
      expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO pricing_catalog_reference_inputs");
      expect(query.mock.calls[0]?.[0]).toContain("last_stream_version < EXCLUDED.last_stream_version");
      expect(query.mock.calls[0]?.[1]).toEqual(["synthetic-item", "field", null, recordedAt, 2]);
    },
  );

  it.each(["published", "deprecated", "archived"])(
    "projects %s and refreshes dependents without per-item queries",
    async (kind) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const handlers = buildPricingCatalogInputProjectionHandlers({ query });
      await handlers[`catalog.reference-record.${kind}`]!({
        streamId: "catalog.reference-record-synthetic-line",
        streamVersion: 2,
        timing: { recordedAt },
        data: {},
      } as never);
      expect(query.mock.calls[0]?.[0]).toContain("last_stream_version <");
      expect(query.mock.calls[1]?.[0]).toContain("UPDATE pricing_catalog_item_inputs");
      expect(query.mock.calls[1]?.[1]).toEqual([null, "synthetic-line", recordedAt]);
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
});
