import { describe, expect, it, vi } from "vitest";
import {
  getScopeObservationSyncStatus,
  getScopeRecordSummary,
  listUnmappedScopeInboxRows,
} from "./scope-coverage-queries";

describe("Scope coverage queries", () => {
  it("lists proposed mappings joined to their canonical scope record", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [
        {
          mapping_id: "map_1",
          scope_record_id: "ref_expansion_paldean_fates",
          review_status: "proposed",
          scope_name: "Paldean Fates",
        },
      ],
    }));

    const result = await listUnmappedScopeInboxRows({ query }, { limit: 50 });

    expect(result).toHaveLength(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN catalog_scope_records r ON r.scope_record_id = m.scope_record_id");
    expect(sql).toContain("WHERE m.review_status = 'proposed'");
    expect(query.mock.calls[0]?.[1]).toEqual([50]);
  });

  it("defaults the inbox limit when none is provided", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    await listUnmappedScopeInboxRows({ query });
    expect(query.mock.calls[0]?.[1]).toEqual([1000]);
  });

  it("looks up a scope record summary by id", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ scope_record_id: "ref_expansion_paldean_fates" }],
    }));
    const result = await getScopeRecordSummary({ query }, "ref_expansion_paldean_fates");
    expect(result).toEqual({ scope_record_id: "ref_expansion_paldean_fates" });
    expect(query.mock.calls[0]?.[1]).toEqual(["ref_expansion_paldean_fates"]);
  });

  it("returns null for a blank scope record id without querying", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const result = await getScopeRecordSummary({ query }, "  ");
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("sums sync status across languages for one provider's coordinates", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ total_observations: "12", promoted_observations: "3" }],
    }));

    const result = await getScopeObservationSyncStatus(
      { query },
      { providerKey: "tcgdex", productLineId: null, seriesId: null, setIdOrName: "sv4-5" },
    );

    expect(result).toEqual({ totalObservations: 12, promotedObservations: 3 });
    expect(query.mock.calls[0]?.[1]).toEqual(["tcgdex", "", "", "sv4-5"]);
  });

  it("returns zero counts when no summary rows exist", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const result = await getScopeObservationSyncStatus(
      { query },
      { providerKey: "scrydex", productLineId: null, seriesId: null, setIdOrName: null },
    );
    expect(result).toEqual({ totalObservations: 0, promotedObservations: 0 });
  });
});
