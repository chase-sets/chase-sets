import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  listSourceObservations,
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  listCatalogMergeCandidates,
  listSourceObservationsForCandidateMatching,
  previewSourceObservationPromotionIds,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
  summarizeSourceObservationLifecycleImpact,
  summarizeSourceObservationReplayImpact,
} from "./queries";

describe("source observation read-model queries", () => {
  it("previews promoted observations as eligible for explicit promotion resync", async () => {
    const db = queryableSequence([[{ count: "7" }], [{ count: "7" }]]);

    const preview = await previewSourceObservationPromotionScope(db, {
      status: "promoted",
      language: "en",
      setId: "base1",
    });

    expect(preview).toMatchObject({
      matched: 7,
      eligible: 7,
      terminal: 0,
      scope: {
        status: "promoted",
        language: "en",
        setId: "base1",
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = ANY"), ["en", "base1", ["promoted"]]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = $3"), ["en", "base1", "promoted"]);
  });

  it("lists eligible observed and changed IDs across the whole matching filter scope", async () => {
    const db = queryable([{ observation_id: "obs_2" }, { observation_id: "obs_1" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      search: "charizard",
      language: "en",
      setId: "base1",
    });

    expect(ids).toEqual(["obs_2", "obs_1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), [
      "en",
      "base1",
      ["observed", "changed"],
      "charizard",
    ]);
  });

  it("lists source observations with indexed search, explicit columns, and clamped pagination parameters", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ observation_id: "obs_1" }]]);

    const result = await listSourceObservations(db, {
      search: "Charizard",
      status: "changed",
      limit: 9e15,
      offset: -10,
    });

    expect(result).toEqual({ items: [{ observation_id: "obs_1" }], total: 1 });
    const listSql = String(vi.mocked(db.query).mock.calls[1]?.[0]);
    expect(listSql).toContain("to_tsvector('simple'");
    expect(listSql).toContain("@@ plainto_tsquery('simple'");
    expect(listSql).not.toContain("SELECT *");
    expect(listSql).not.toContain("source_payload");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $3 OFFSET $4"), [
      "changed",
      "Charizard",
      500,
      0,
    ]);
  });

  it("lists candidate matching observations by sync run without relying on job payload parsing", async () => {
    const db = queryable([{ observation_id: "obs_sync_1", sync_run_id: "job_sync_1" }]);

    const rows = await listSourceObservationsForCandidateMatching(db, {
      syncRunId: "job_sync_1",
      language: "en",
    });

    expect(rows).toEqual([{ observation_id: "obs_sync_1", sync_run_id: "job_sync_1" }]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("sync_run_id = $1"), [
      "job_sync_1",
      "en",
      ["observed", "changed", "promoted"],
    ]);
  });

  it("lists merge candidates by sync run and status for review workbenches", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ candidate_id: "cand_1", observation_count: 2 }]]);

    const result = await listCatalogMergeCandidates(db, {
      syncRunId: "job_sync_1",
      status: "has-conflicts",
      search: "charizard_%",
      limit: 10,
    });

    expect(result).toEqual({ items: [{ candidate_id: "cand_1", observation_count: 2 }], total: 1 });
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM catalog_merge_candidates c WHERE c.status = $1 AND c.sync_run_ids_json ? $2"),
      ["has-conflicts", "job_sync_1", "%charizard\\_\\%%"],
    );
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("ILIKE $3 ESCAPE '\\'");
    const listSql = String(vi.mocked(db.query).mock.calls[1]?.[0]);
    expect(listSql).toContain("LEFT JOIN LATERAL");
    expect(listSql).toContain("WHERE candidate_id = c.candidate_id");
    expect(listSql).not.toContain("GROUP BY candidate_id");
    expect(listSql).not.toContain("SELECT c.*");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LEFT JOIN LATERAL"), [
      "has-conflicts",
      "job_sync_1",
      "%charizard\\_\\%%",
      10,
      0,
    ]);
  });

  it("lists merge candidates by operator-selected provider scope without requiring the current parent sync run", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ candidate_id: "cand_base", observation_count: 102 }]]);

    const result = await listCatalogMergeCandidates(db, {
      provider: "tcgplayer",
      language: "en",
      productLineId: "3",
      productLineName: "Pokemon",
      expansionId: "Base Set",
      limit: 25,
    });

    expect(result).toEqual({ items: [{ candidate_id: "cand_base", observation_count: 102 }], total: 1 });
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("EXISTS"), [
      "tcgplayer",
      "en",
      "3",
      "Pokemon",
      "Base Set",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("catalog_merge_candidate_observations scoped_mco"),
      ["tcgplayer", "en", "3", "Pokemon", "Base Set"],
    );
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("so.normalized->>'setName'"), [
      "tcgplayer",
      "en",
      "3",
      "Pokemon",
      "Base Set",
    ]);
  });

  it("lists only changed IDs when the current status filter is changed", async () => {
    const db = queryable([{ observation_id: "obs_changed" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      status: "changed",
      language: "en",
    });

    expect(ids).toEqual(["obs_changed"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), ["en", ["changed"]]);
  });

  it("applies structured product-line and series filters without requiring an expansion", async () => {
    const db = queryable([{ observation_id: "obs_sv8" }, { observation_id: "obs_sv1" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      provider: "tcgdex",
      language: "ja",
      productLineId: "3",
      seriesId: "sv",
    });

    expect(ids).toEqual(["obs_sv8", "obs_sv1"]);
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("source_payload->'detail'->>'productLineId'");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), [
      "tcgdex",
      "ja",
      "3",
      "sv",
      ["observed", "changed"],
    ]);
  });

  it("lists promoted IDs when the current status filter is promoted", async () => {
    const db = queryable([{ observation_id: "obs_promoted" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      status: "promoted",
      language: "en",
    });

    expect(ids).toEqual(["obs_promoted"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), ["en", ["promoted"]]);
  });

  it("previews explicit promotion selections without broadening to the filtered scope", async () => {
    const db = queryable([{ matched: "3", eligible: "2" }]);

    const preview = await previewSourceObservationPromotionIds(db, ["obs_1", "obs_2", "obs_1", " "]);

    expect(preview).toMatchObject({
      matched: 3,
      eligible: 2,
      terminal: 1,
      scope: {
        search: "",
        status: "",
        provider: "",
        language: "",
        setId: "",
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("observation_id = ANY($1)"), [["obs_1", "obs_2"]]);
  });

  it("carries a content fingerprint computed from the eligible observations for explicit IDs", async () => {
    const db = queryable([{ matched: "2", eligible: "2", fingerprint: "abc123" }]);

    const preview = await previewSourceObservationPromotionIds(db, ["obs_1", "obs_2"]);

    expect(preview.fingerprint).toBe("abc123");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("STRING_AGG"), [["obs_1", "obs_2"]]);
  });

  it("returns an empty fingerprint (not null/undefined) when the explicit selection is empty", async () => {
    const db = queryable([]);

    const preview = await previewSourceObservationPromotionIds(db, []);

    expect(preview).toEqual({
      matched: 0,
      eligible: 0,
      terminal: 0,
      scope: expect.objectContaining({}),
      fingerprint: "",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("carries a content fingerprint for the scope-wide preview, distinct from a null-safe default", async () => {
    const db = queryableSequence([[{ count: "5", fingerprint: "scope-fp-1" }], [{ count: "5" }]]);

    const preview = await previewSourceObservationPromotionScope(db, { status: "observed", language: "en" });

    expect(preview.fingerprint).toBe("scope-fp-1");
  });

  it("does not query IDs when the current status filter is terminal", async () => {
    const db = queryable([]);

    await expect(listSourceObservationIdsForPromotion(db, { status: "rejected" })).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("previews promoted observations as eligible for reapply", async () => {
    const db = queryableSequence([[{ count: "7" }], [{ count: "12" }], [], [], []]);

    const preview = await previewSourceObservationReapplyScope(db, {
      language: "en",
      setId: "base1",
    });

    expect(preview).toMatchObject({
      matched: 12,
      eligible: 7,
      ineligible: 5,
      scope: {
        language: "en",
        setId: "base1",
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("COUNT(*)"), ["en", "base1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = ANY"), ["en", "base1", ["promoted"]]);
  });

  it("summarizes replay impact with Catalog Item and external reference samples", async () => {
    const db = queryableSequence([
      [{ count: "3" }],
      [{ count: "5" }],
      [
        { promoted_catalog_item_id: "cat_1", total_count: "2" },
        { promoted_catalog_item_id: "cat_2", total_count: "2" },
      ],
      [
        {
          observation_id: "obs_1",
          reference_kind: "catalog-item-reference",
          provider_key: "tcgdex",
          external_key: "card:1",
          catalog_item_id: "cat_1",
          reference_count: "4",
        },
        {
          observation_id: "obs_2",
          reference_kind: "product-reference",
          provider_key: "tcgdex",
          external_key: "sku:2",
          catalog_item_id: "cat_2",
          reference_count: "4",
        },
      ],
      [{ observation_id: "obs_1" }, { observation_id: "obs_2" }],
    ]);

    const impact = await summarizeSourceObservationReplayImpact(db, { provider: "tcgdex" }, { sampleLimit: 2 });

    expect(impact).toMatchObject({
      matchedObservations: 5,
      eligibleObservations: 3,
      blockedObservations: 2,
      impactedCatalogItemCount: 2,
      impactedCatalogItemIds: ["cat_1", "cat_2"],
      externalReferenceCount: 4,
      sampleObservationIds: ["obs_1", "obs_2"],
    });
    expect(impact.externalReferenceSamples[0]).toMatchObject({
      observationId: "obs_1",
      referenceKind: "catalog-item-reference",
      providerKey: "tcgdex",
      externalKey: "card:1",
      catalogItemId: "cat_1",
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 2"), ["tcgdex", ["promoted"]]);
  });

  it("summarizes profile lifecycle impact references without raw payload rows", async () => {
    const db = queryableSequence([
      [{ referenced_count: "6", source_count: "4", promotion_count: "2" }],
      [{ promoted_catalog_item_id: "cat_9", total_count: "1" }],
      [
        {
          observation_id: "obs_9",
          reference_kind: "product-reference",
          provider_key: "tcgplayer",
          external_key: "sku:9",
          catalog_item_id: "cat_9",
          reference_count: "1",
        },
      ],
      [{ observation_id: "obs_9" }],
    ]);

    const impact = await summarizeSourceObservationLifecycleImpact(db, {
      providerKey: "tcgplayer",
      profileVersion: "v2",
      operation: "retire",
      sampleLimit: 1,
    });

    expect(impact).toMatchObject({
      referencedObservationCount: 6,
      sourceProfileReferenceCount: 4,
      promotionProfileReferenceCount: 2,
      impactedCatalogItemCount: 1,
      impactedCatalogItemIds: ["cat_9"],
      externalReferenceCount: 1,
      sampleObservationIds: ["obs_9"],
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("source_profile_version = $2"), ["tcgplayer", "v2"]);
  });

  it("lists promoted IDs across the whole matching reapply scope", async () => {
    const db = queryable([{ observation_id: "obs_promoted_2" }, { observation_id: "obs_promoted_1" }]);

    const ids = await listSourceObservationIdsForReapply(db, {
      search: "abra",
      language: "en",
      setId: "base1",
    });

    expect(ids).toEqual(["obs_promoted_2", "obs_promoted_1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), [
      "en",
      "base1",
      ["promoted"],
      "abra",
    ]);
  });

  it("does not query reapply IDs when the current status filter is not promoted", async () => {
    const db = queryable([]);

    await expect(listSourceObservationIdsForReapply(db, { status: "changed" })).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("summarizes pulled provider scopes by language expansion and series", async () => {
    const db = queryable([
      {
        provider_key: "tcgdex",
        language_code: "en",
        expansion_id: "base1",
        expansion_name: "Base Set",
        series_id: "base",
        series_name: "Base",
        total_observations: 102,
        observed_observations: 100,
        changed_observations: 1,
        promoted_observations: 1,
        rejected_observations: 1,
        first_observed_at: "2026-05-16T00:00:00.000Z",
        latest_observed_at: "2026-05-16T00:01:00.000Z",
        latest_source_updated_at: null,
      },
    ]);

    const scopes = await listSourceObservationIntegrationScopes(db, {
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      provider_key: "tcgdex",
      language_code: "en",
      expansion_id: "base1",
      series_name: "Base",
      total_observations: 102,
      observed_observations: 100,
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM catalog_source_observation_integration_scope_summaries"),
      ["tcgdex", "en", "base1"],
    );
    const sql = String(vi.mocked(db.query).mock.calls[0]?.[0]);
    expect(sql).toContain("ORDER BY latest_observed_at DESC");
    expect(sql).not.toContain("GROUP BY");
    expect(sql).not.toContain("FROM catalog_source_observations");
    expect(sql).not.toContain("normalized->");
  });

  it("filters source-observation integration scopes through summary-table columns and index order", async () => {
    const db = queryable([]);

    await listSourceObservationIntegrationScopes(db, {
      provider: "tcgplayer",
      language: "en",
      productLineId: "3",
      seriesId: "sv",
      expansionId: "sv8",
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM catalog_source_observation_integration_scope_summaries"),
      ["tcgplayer", "en", "3", "sv", "sv8"],
    );
    const sql = String(vi.mocked(db.query).mock.calls[0]?.[0]);
    expect(sql).toContain("provider_key = $1");
    expect(sql).toContain("language_code = $2");
    expect(sql).toContain("product_line_id = $3");
    expect(sql).toContain("series_id = $4");
    expect(sql).toContain("expansion_id = $5");
    expect(sql).not.toContain("source_payload");
    expect(sql).not.toContain("jsonb");
  });
});

function queryable(rows: readonly Record<string, unknown>[]): PgQueryable {
  return {
    query: vi.fn(async () => ({
      rows: [...rows],
      rowCount: rows.length,
    })),
  };
}

function queryableSequence(results: readonly (readonly Record<string, unknown>[])[]): PgQueryable {
  let index = 0;

  return {
    query: vi.fn(async () => {
      const rows = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return {
        rows: [...rows],
        rowCount: rows.length,
      };
    }),
  };
}
