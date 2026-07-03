import { describe, expect, it, vi } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "./projection";

const normalized: SourceObservationNormalized = {
  kind: "pokemon-card",
  tcg: "pokemon",
  languageCode: "en",
  name: "Abra",
  cardNumber: "43",
  setId: "base1",
  setName: "Base Set",
  expansionId: "base1",
  expansionName: "Base Set",
  expansionAbbreviation: "BS",
  expansionCardCount: 102,
  expansionParallelSetCardCount: null,
  seriesId: "base",
  seriesName: "Base",
  rarity: "Common",
  illustrator: null,
  releaseDate: "1999-01-09",
  releaseYear: 1999,
  category: "Pokemon",
  imageBaseUrl: "https://assets.tcgdex.net/en/base/base1/43",
  imageUrls: ["https://assets.tcgdex.net/en/base/base1/43/high.webp"],
  productAssetSet: null,
  parallelSet: false,
  cardVariantKey: "standard-set",
  cardVariantLabel: "Standard Set",
  cardVariantSourceKey: "normal",
  cardVariantIsPrimaryImage: true,
  imageDisclaimer: null,
  variants: { normal: true },
};

describe("Source Observation projections", () => {
  it("repairs missing rows from refreshed unchanged observations", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.refreshed"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: {
        ...observationData(),
        status: "promoted",
        statusReason: null,
        promotedCatalogItemId: "cat_1",
        promotedReferenceRecordId: null,
        promotedAt: "2026-05-28T14:00:00.000Z",
      },
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO catalog_source_observations"), [
      "tcgdex_en_base1_043",
      "job_sync_base1",
      "tcgdex",
      "base1-43",
      "https://api.tcgdex.net/v2/en/cards/base1-43",
      "en",
      "hash",
      null,
      "2026-05-28T14:04:00.000Z",
      "pokemon-tcg",
      "2026.06.03",
      "mapping-fingerprint",
      JSON.stringify(normalized),
      JSON.stringify({ id: "base1-43" }),
      "promoted",
      null,
      "cat_1",
      null,
      "2026-05-28T14:00:00.000Z",
      null,
      null,
      null,
      "2026-05-28T14:05:00.000Z",
    ]);
    const insertCall = findQueryCall(query, "INSERT INTO catalog_source_observations");
    expect(insertCall[0]).toContain("ON CONFLICT (observation_id) DO UPDATE");
    expect(insertCall[0]).toContain("promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id");
    expect(insertCall[0]).toContain("promoted_reference_record_id = EXCLUDED.promoted_reference_record_id");
  });

  it("upserts changed observations so a new change can repair a missing row", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.changed"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: observationData({ sourceRecordHash: "new-hash" }),
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    const insertCall = findQueryCall(query, "INSERT INTO catalog_source_observations");
    expect(insertCall[0]).toContain("ON CONFLICT (observation_id) DO UPDATE");
    expect(insertCall[0]).not.toContain("promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id");
    expect(insertCall[0]).not.toContain("promoted_reference_record_id = EXCLUDED.promoted_reference_record_id");
    expect(insertCall[1]?.[14]).toBe("changed");
  });

  it("projects Reference Record promotion targets separately from Catalog Item targets", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.reference-promoted"]?.({
      streamId: "catalog.source-observation-mtgjson_en_tsp",
      data: {
        referenceRecordId: "ref_mtgjson_set_tsp",
        promotedAt: "2026-06-19T10:00:00.000Z",
        promotionProfileKey: "mtg-set-reference-data",
        promotionProfileVersion: "2026.06.19",
        promotionPlanFingerprint: "sha256:reference",
      },
      timing: { recordedAt: "2026-06-19T10:00:01.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("promoted_reference_record_id = $2"), [
      "mtgjson_en_tsp",
      "ref_mtgjson_set_tsp",
      "2026-06-19T10:00:00.000Z",
      "mtg-set-reference-data",
      "2026.06.19",
      "sha256:reference",
      "2026-06-19T10:00:01.000Z",
    ]);
    expect(findQueryCall(query, "promoted_reference_record_id = $2")[0]).toContain("promoted_catalog_item_id = NULL");
  });

  it("projects deferrals without removing the observation from review", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.deferred"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: {
        reason: "Needs better provider evidence.",
        deferredAt: "2026-05-28T14:04:30.000Z",
        reviewStatus: "changed",
      },
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = $2"), [
      "tcgdex_en_base1_043",
      "changed",
      "Needs better provider evidence.",
      "2026-05-28T14:05:00.000Z",
    ]);
  });

  it("rejects retired legacy source profile markers instead of projecting fallback metadata", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await expect(
      handlers["catalog.source-observation.changed"]?.({
        streamId: "catalog.source-observation-tcgdex_en_base1_043",
        data: observationData({ sourceProfileVersion: "legacy" }),
        timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
      } as never),
    ).rejects.toThrow("Source observation source profile version cannot use the retired legacy marker.");
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO catalog_source_observations"),
      expect.anything(),
    );
  });

  it("refreshes integration scope summaries for observation record, change, refresh, promotion, rejection, and deferral", async () => {
    const cases = [
      {
        eventType: "catalog.source-observation.recorded",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: observationData(),
          timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
        },
      },
      {
        eventType: "catalog.source-observation.changed",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: observationData({ sourceRecordHash: "new-hash" }),
          timing: { recordedAt: "2026-05-28T14:06:00.000Z" },
        },
      },
      {
        eventType: "catalog.source-observation.refreshed",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: {
            ...observationData(),
            status: "changed",
            statusReason: "Provider payload changed.",
            promotedCatalogItemId: null,
            promotedReferenceRecordId: null,
            promotedAt: null,
          },
          timing: { recordedAt: "2026-05-28T14:07:00.000Z" },
        },
      },
      {
        eventType: "catalog.source-observation.promoted",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: {
            catalogItemId: "cat_1",
            promotedAt: "2026-05-28T14:08:00.000Z",
            promotionProfileKey: "pokemon-tcg",
            promotionProfileVersion: "2026.06.03",
            promotionPlanFingerprint: "sha256:promotion",
          },
          timing: { recordedAt: "2026-05-28T14:08:01.000Z" },
        },
      },
      {
        eventType: "catalog.source-observation.rejected",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: { reason: "Duplicate provider record." },
          timing: { recordedAt: "2026-05-28T14:09:00.000Z" },
        },
      },
      {
        eventType: "catalog.source-observation.deferred",
        event: {
          streamId: "catalog.source-observation-tcgdex_en_base1_043",
          data: { reason: "Needs better evidence.", reviewStatus: "observed" },
          timing: { recordedAt: "2026-05-28T14:10:00.000Z" },
        },
      },
    ] as const;

    for (const { eventType, event } of cases) {
      const query = sourceObservationScopeAwareQuery();
      const handlers = buildSourceObservationProjectionHandlers({ query });

      await handlers[eventType]?.(event as never);

      const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
      expect(sql).toContain("DELETE FROM catalog_source_observation_integration_scope_summaries");
      expect(sql).toContain("INSERT INTO catalog_source_observation_integration_scope_summaries");
      expect(sql).toContain("FROM catalog_source_observations");
      expect(sql).toContain("GROUP BY");
    }
  });
});

function observationData(
  overrides: Partial<{
    sourceRecordHash: string;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    sourceMappingFingerprint: string;
    syncRunId: string | null;
  }> = {},
) {
  return {
    observationId: "tcgdex_en_base1_043",
    syncRunId: "job_sync_base1",
    providerKey: "tcgdex",
    externalKey: "base1-43",
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-43",
    languageCode: "en",
    sourceRecordHash: "hash",
    sourceUpdatedAt: null,
    observedAt: "2026-05-28T14:04:00.000Z",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    sourceMappingFingerprint: "mapping-fingerprint",
    normalized,
    sourcePayload: { id: "base1-43" },
    ...overrides,
  };
}

function sourceObservationScopeAwareQuery() {
  return vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql.includes("SELECT provider_key") && sql.includes("WHERE observation_id = $1")) {
      return {
        rows: [
          {
            provider_key: "tcgdex",
            language_code: "en",
            product_line_id: "pokemon",
            series_id: "base",
            expansion_id: "base1",
          },
        ],
      };
    }
    return { rows: [] };
  });
}

function findQueryCall(query: ReturnType<typeof vi.fn>, sqlFragment: string): [string, readonly unknown[] | undefined] {
  const call = query.mock.calls.find(([sql]) => String(sql).includes(sqlFragment));
  expect(call, `Expected a query containing ${sqlFragment}`).toBeDefined();
  return call as [string, readonly unknown[] | undefined];
}
