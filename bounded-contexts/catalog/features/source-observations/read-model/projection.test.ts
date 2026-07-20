import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import { buildSourceObservationProjectionHandlers } from "./projection";

type ObservationRow = Readonly<Record<string, unknown>>;
type ScopeSummaryRow = Readonly<{
  provider_key: string;
  language_code: string;
  product_line_id: string;
  series_id: string;
  expansion_id: string;
  total_observations: number;
  observed_observations: number;
  changed_observations: number;
  promoted_observations: number;
  rejected_observations: number;
}>;

class SourceObservationProjectionDb implements PgQueryable {
  public readonly observations = new Map<string, ObservationRow>();
  public readonly summaries = new Map<string, ScopeSummaryRow>();
  public readonly payloadAssemblies = new Map<
    string,
    { sourceRecordHash: string; eventType: string; recordData: unknown; expectedChunkCount: number; chunks: string[] }
  >();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO catalog_source_observation_payload_assemblies")) {
      this.payloadAssemblies.set(String(values[0]), {
        sourceRecordHash: String(values[1]),
        eventType: String(values[2]),
        recordData: JSON.parse(String(values[3])),
        expectedChunkCount: Number(values[4]),
        chunks: [],
      });
      return emptyResult();
    }

    if (sql.includes("UPDATE catalog_source_observation_payload_assemblies")) {
      const observationId = String(values[0]);
      const assembly = this.payloadAssemblies.get(observationId);
      if (
        !assembly ||
        assembly.sourceRecordHash !== String(values[1]) ||
        assembly.chunks.length !== Number(values[2]) ||
        assembly.expectedChunkCount !== Number(values[3])
      ) {
        return emptyResult();
      }
      assembly.chunks.push(String(values[4]));
      return {
        rows: [
          {
            record_event_type: assembly.eventType,
            record_data: assembly.recordData,
            encoded_chunks: assembly.chunks,
          },
        ] as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes("DELETE FROM catalog_source_observation_payload_assemblies")) {
      this.payloadAssemblies.delete(String(values[0]));
      return emptyResult();
    }

    if (sql.includes("SELECT provider_key") && sql.includes("WHERE observation_id = $1")) {
      const row = this.observations.get(String(values[0]));
      const scope = row ? scopeFor(row) : null;
      return {
        rows: (scope ? [scope] : []) as Row[],
        rowCount: scope ? 1 : 0,
      };
    }

    if (sql.includes("INSERT INTO catalog_source_observations")) {
      const observationId = String(values[0]);
      const previous = this.observations.get(observationId);
      const writesPromotionState = sql.includes("promoted_catalog_item_id = EXCLUDED");
      this.observations.set(observationId, {
        observation_id: observationId,
        sync_run_id: values[1],
        provider_key: values[2],
        external_key: values[3],
        source_url: values[4],
        language_code: values[5],
        source_record_hash: values[6],
        source_updated_at: values[7],
        observed_at: values[8],
        source_profile_key: values[9],
        source_profile_version: values[10],
        source_mapping_fingerprint: values[11],
        normalized: JSON.parse(String(values[12])),
        source_payload: JSON.parse(String(values[13])),
        status: values[14],
        status_reason: values[15],
        promoted_catalog_item_id: writesPromotionState ? values[16] : (previous?.promoted_catalog_item_id ?? null),
        promoted_reference_record_id: writesPromotionState
          ? values[17]
          : (previous?.promoted_reference_record_id ?? null),
        promoted_at: writesPromotionState ? values[18] : (previous?.promoted_at ?? null),
        promotion_profile_key: writesPromotionState ? values[19] : (previous?.promotion_profile_key ?? null),
        promotion_profile_version: writesPromotionState ? values[20] : (previous?.promotion_profile_version ?? null),
        promotion_plan_fingerprint: writesPromotionState ? values[21] : (previous?.promotion_plan_fingerprint ?? null),
        updated_at: values[22],
      });
      return emptyResult();
    }

    if (sql.includes("UPDATE catalog_source_observations")) {
      const observationId = String(values[0]);
      const previous = this.observations.get(observationId);
      if (!previous) {
        return emptyResult();
      }

      if (sql.includes("SET status = 'promoted'")) {
        this.observations.set(observationId, {
          ...previous,
          status: "promoted",
          promoted_catalog_item_id: sql.includes("promoted_catalog_item_id = $2") ? values[1] : null,
          promoted_reference_record_id: sql.includes("promoted_reference_record_id = $2") ? values[1] : null,
          promoted_at: values[2],
          status_reason: null,
          promotion_profile_key: values[3],
          promotion_profile_version: values[4],
          promotion_plan_fingerprint: values[5],
          updated_at: values[6],
        });
      } else if (sql.includes("SET promoted_catalog_item_id = $2")) {
        this.observations.set(observationId, {
          ...previous,
          promoted_catalog_item_id: values[1],
          promoted_reference_record_id: null,
          promotion_profile_key: values[2],
          promotion_profile_version: values[3],
          promotion_plan_fingerprint: values[4],
          updated_at: values[5],
        });
      } else if (sql.includes("SET promoted_catalog_item_id = NULL")) {
        this.observations.set(observationId, {
          ...previous,
          promoted_catalog_item_id: null,
          promoted_reference_record_id: values[1],
          promotion_profile_key: values[2],
          promotion_profile_version: values[3],
          promotion_plan_fingerprint: values[4],
          updated_at: values[5],
        });
      } else if (sql.includes("SET status = $2")) {
        this.observations.set(observationId, {
          ...previous,
          status: values[1],
          status_reason: values[2],
          updated_at: values[3],
        });
      }
      return emptyResult();
    }

    if (sql.includes("DELETE FROM catalog_source_observation_integration_scope_summaries")) {
      this.summaries.delete(scopeKey(values));
      return emptyResult();
    }

    if (sql.includes("INSERT INTO catalog_source_observation_integration_scope_summaries")) {
      const key = scopeKey(values);
      const rows = [...this.observations.values()].filter((row) => scopeKeyFromRow(row) === key);
      if (rows.length > 0) {
        this.summaries.set(key, {
          provider_key: String(values[0]),
          language_code: String(values[1]),
          product_line_id: String(values[2]),
          series_id: String(values[3]),
          expansion_id: String(values[4]),
          total_observations: rows.length,
          observed_observations: rows.filter((row) => row.status === "observed").length,
          changed_observations: rows.filter((row) => row.status === "changed").length,
          promoted_observations: rows.filter((row) => row.status === "promoted").length,
          rejected_observations: rows.filter((row) => row.status === "rejected").length,
        });
      }
      return emptyResult();
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

describe("Source Observation projections", () => {
  it("materializes chunked provider evidence only after the complete ordered payload replays", async () => {
    const db = new SourceObservationProjectionDb();
    const handlers = buildSourceObservationProjectionHandlers(db);
    const payload = { cards: Array.from({ length: 2_000 }, (_, index) => ({ index, name: `Card ${index} λ` })) };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const chunks = [encoded.slice(0, 30_000), encoded.slice(30_000)];
    const { sourcePayload: _sourcePayload, ...baseData } = observationData();
    const header = {
      ...baseData,
      sourcePayloadEncoding: "json-utf8-base64-v1",
      sourcePayloadChunkCount: chunks.length,
    };

    await handlers["catalog.source-observation.recorded"]?.(
      observationEvent("catalog.source-observation.recorded", header as never),
    );
    expect(db.observations.size).toBe(0);

    for (const [chunkIndex, encodedPayload] of chunks.entries()) {
      await handlers["catalog.source-observation.source-payload-chunk-recorded"]?.({
        streamId: "catalog.source-observation-tcgdex_en_base1_043",
        data: {
          observationId: "tcgdex_en_base1_043",
          sourceRecordHash: "hash",
          chunkIndex,
          chunkCount: chunks.length,
          encodedPayload,
        },
        timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
      } as never);
    }

    expect(db.observations.get("tcgdex_en_base1_043")).toMatchObject({ source_payload: payload });
    expect(db.payloadAssemblies.size).toBe(0);
    expect(db.summaries.get("tcgdex\u0000en\u0000pokemon\u0000base\u0000base1")).toMatchObject({
      total_observations: 1,
      observed_observations: 1,
    });
  });

  it("repairs missing rows from refreshed unchanged observations", async () => {
    const db = new SourceObservationProjectionDb();
    const handlers = buildSourceObservationProjectionHandlers(db);

    await handlers["catalog.source-observation.refreshed"]?.(
      refreshedEvent({
        status: "promoted",
        statusReason: null,
        promotedCatalogItemId: "cat_1",
        promotedReferenceRecordId: null,
        promotedAt: "2026-05-28T14:00:00.000Z",
      }),
    );

    expect(db.observations.get("tcgdex_en_base1_043")).toMatchObject({
      status: "promoted",
      promoted_catalog_item_id: "cat_1",
      normalized,
    });
    expect(db.summaries.get("tcgdex\u0000en\u0000pokemon\u0000base\u0000base1")).toMatchObject({
      total_observations: 1,
      promoted_observations: 1,
    });
  });

  it("upserts changed observations so a new change can repair a missing row", async () => {
    const db = new SourceObservationProjectionDb();
    const handlers = buildSourceObservationProjectionHandlers(db);

    await handlers["catalog.source-observation.changed"]?.(
      observationEvent("catalog.source-observation.changed", observationData({ sourceRecordHash: "new-hash" })),
    );

    expect(db.observations.get("tcgdex_en_base1_043")).toMatchObject({
      source_record_hash: "new-hash",
      status: "changed",
      promoted_catalog_item_id: null,
    });
  });

  it("projects Reference Record promotion targets separately from Catalog Item targets", async () => {
    const db = seededDb(true);
    const handlers = buildSourceObservationProjectionHandlers(db);

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

    // The handler targets the stream's observation id; seed that row for the state assertion.
    expect(db.observations.get("mtgjson_en_tsp")).toMatchObject({
      promoted_reference_record_id: "ref_mtgjson_set_tsp",
      promoted_catalog_item_id: null,
    });
  });

  it("projects deferrals without removing the observation from review", async () => {
    const db = seededDb();
    const handlers = buildSourceObservationProjectionHandlers(db);

    await handlers["catalog.source-observation.deferred"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: {
        reason: "Needs better provider evidence.",
        deferredAt: "2026-05-28T14:04:30.000Z",
        reviewStatus: "changed",
      },
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    expect(db.observations.get("tcgdex_en_base1_043")).toMatchObject({
      status: "changed",
      status_reason: "Needs better provider evidence.",
    });
  });

  it("rejects retired legacy source profile markers instead of projecting fallback metadata", async () => {
    const db = new SourceObservationProjectionDb();
    const handlers = buildSourceObservationProjectionHandlers(db);

    await expect(
      handlers["catalog.source-observation.changed"]?.(
        observationEvent("catalog.source-observation.changed", observationData({ sourceProfileVersion: "legacy" })),
      ),
    ).rejects.toThrow("Source observation source profile version cannot use the retired legacy marker.");
    expect(db.observations.size).toBe(0);
  });

  it("refreshes integration scope summaries for observation lifecycle changes", async () => {
    const cases = [
      [
        "catalog.source-observation.recorded",
        observationEvent("catalog.source-observation.recorded", observationData()),
      ],
      ["catalog.source-observation.changed", observationEvent("catalog.source-observation.changed", observationData())],
      [
        "catalog.source-observation.refreshed",
        refreshedEvent({
          status: "changed",
          statusReason: "Provider payload changed.",
          promotedCatalogItemId: null,
          promotedReferenceRecordId: null,
          promotedAt: null,
        }),
      ],
      ["catalog.source-observation.promoted", promotedEvent()],
      ["catalog.source-observation.rejected", rejectedEvent()],
      ["catalog.source-observation.deferred", deferredEvent()],
    ] as const;

    for (const [eventType, event] of cases) {
      const db = seededDb();
      const handlers = buildSourceObservationProjectionHandlers(db);
      await handlers[eventType]?.(event as never);
      expect(db.summaries.get("tcgdex\u0000en\u0000pokemon\u0000base\u0000base1")).toMatchObject({
        total_observations: 1,
      });
    }
  });
});

const normalized: SourceObservationNormalized = normalizedObservation({
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
  imageBaseUrl: "https://assets.tcgdex.net/en/base/base1/43",
  imageUrls: ["https://assets.tcgdex.net/en/base/base1/43/high.webp"],
});

function seededDb(includeReferenceObservation = false) {
  const db = new SourceObservationProjectionDb();
  db.observations.set("tcgdex_en_base1_043", observationRow(observationData()));
  if (includeReferenceObservation) {
    db.observations.set("mtgjson_en_tsp", observationRow(observationData({ observationId: "mtgjson_en_tsp" })));
  }
  return db;
}

function observationRow(data: ReturnType<typeof observationData>): ObservationRow {
  return {
    observation_id: data.observationId,
    sync_run_id: data.syncRunId,
    provider_key: data.providerKey,
    external_key: data.externalKey,
    source_url: data.sourceUrl,
    language_code: data.languageCode,
    source_record_hash: data.sourceRecordHash,
    source_updated_at: data.sourceUpdatedAt,
    observed_at: data.observedAt,
    source_profile_key: data.sourceProfileKey,
    source_profile_version: data.sourceProfileVersion,
    source_mapping_fingerprint: data.sourceMappingFingerprint,
    normalized: data.normalized,
    source_payload: data.sourcePayload,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
  };
}

function observationData(
  overrides: Partial<{
    observationId: string;
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

function observationEvent(type: string, data: ReturnType<typeof observationData>) {
  return {
    streamId: `catalog.source-observation-${data.observationId}`,
    data,
    timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    type,
  } as never;
}

function refreshedEvent(data: {
  status: "observed" | "changed" | "promoted" | "rejected";
  statusReason: string | null;
  promotedCatalogItemId: string | null;
  promotedReferenceRecordId: string | null;
  promotedAt: string | null;
}) {
  return observationEvent("catalog.source-observation.refreshed", { ...observationData(), ...data });
}

function promotedEvent() {
  return {
    streamId: "catalog.source-observation-tcgdex_en_base1_043",
    data: {
      catalogItemId: "cat_1",
      promotedAt: "2026-05-28T14:08:00.000Z",
      promotionProfileKey: "pokemon-tcg",
      promotionProfileVersion: "2026.06.03",
      promotionPlanFingerprint: "sha256:promotion",
    },
    timing: { recordedAt: "2026-05-28T14:08:01.000Z" },
  } as never;
}

function rejectedEvent() {
  return {
    streamId: "catalog.source-observation-tcgdex_en_base1_043",
    data: { reason: "Duplicate provider record." },
    timing: { recordedAt: "2026-05-28T14:09:00.000Z" },
  } as never;
}

function deferredEvent() {
  return {
    streamId: "catalog.source-observation-tcgdex_en_base1_043",
    data: { reason: "Needs better evidence.", reviewStatus: "observed" },
    timing: { recordedAt: "2026-05-28T14:10:00.000Z" },
  } as never;
}

function scopeFor(row: ObservationRow) {
  const scope = scopeForRow(row);
  return {
    provider_key: scope[0],
    language_code: scope[1],
    product_line_id: scope[2],
    series_id: scope[3],
    expansion_id: scope[4],
  };
}

function scopeKey(values: readonly unknown[]) {
  return values.slice(0, 5).map(String).join("\u0000");
}

function scopeKeyFromRow(row: ObservationRow) {
  return scopeForRow(row).join("\u0000");
}

function scopeForRow(row: ObservationRow): [string, string, string, string, string] {
  const normalized = row.normalized as Record<string, unknown>;
  return [
    String(row.provider_key),
    String(row.language_code),
    String(row.provider_key === "tcgdex" ? "pokemon" : ""),
    String(normalized.seriesId ?? ""),
    String(normalized.expansionId ?? normalized.setId ?? normalized.setName ?? ""),
  ];
}

function emptyResult<Row = Record<string, unknown>>(): PgQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}
