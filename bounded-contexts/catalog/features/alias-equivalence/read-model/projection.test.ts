import { describe, expect, it, vi } from "vitest";
import { buildCatalogAliasCandidate } from "../domain/alias";
import { catalogAliasStreamId } from "../domain/domain";
import { buildCatalogAliasProjectionHandlers, upsertSourceObservationAliasCandidates } from "./projection";

function candidate(kind: "catalog-item" | "reference-record" = "catalog-item") {
  return buildCatalogAliasCandidate(
    kind === "catalog-item"
      ? {
          target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
          aliasText: "Dracaufeu",
          aliasLanguageCode: "fr",
          aliasType: "official-equivalent",
          confidence: "high",
          reviewStatus: "pending",
          provenance: {
            providerKey: "tcgdex",
            observationId: "obs_1",
            sourceCategory: "provider-same-id-localized-endpoint",
            sourceProfileKey: "pokemon-tcg",
            sourceProfileVersion: "2026.06.03",
            mappingFingerprint: "fp-1",
          },
          evidence: { sharedId: "base1-4" },
        }
      : {
          target: { kind: "reference-record", targetId: "ref_1", targetKey: "expansion" },
          aliasText: "リザードン拡張",
          aliasLanguageCode: "ja",
          aliasType: "set-equivalent",
          confidence: "exact",
          reviewStatus: "auto-accepted",
          provenance: {
            providerKey: "tcgdex",
            observationId: "obs_2",
            sourceCategory: "provider-same-id-localized-endpoint",
            sourceProfileKey: "pokemon-tcg",
            sourceProfileVersion: "2026.06.03",
            mappingFingerprint: "fp-1",
          },
          evidence: {},
        },
  );
}

describe("Source Observation alias candidate persistence", () => {
  it("upserts each candidate by alias hash idempotently", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    await upsertSourceObservationAliasCandidates({ query }, [candidate()], "2026-06-16T00:00:00.000Z");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain("INSERT INTO catalog_source_observation_alias_candidates");
    expect(sql).toContain("ON CONFLICT (alias_hash) DO UPDATE");
    expect(params?.[0]).toBe(candidate().aliasHash);
    expect(params?.[5]).toBe("dracaufeu"); // normalized_alias_text
  });
});

describe("Catalog Alias projection", () => {
  it("projects a proposed catalog-item alias into catalog_item_aliases", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogAliasProjectionHandlers({ query });
    const c = candidate("catalog-item");

    await handlers["catalog.alias.proposed"]?.({
      streamId: catalogAliasStreamId(c.aliasHash),
      data: {
        aliasHash: c.aliasHash,
        target: c.target,
        aliasText: c.aliasText,
        normalizedAliasText: c.normalizedAliasText,
        aliasLanguageCode: c.aliasLanguageCode,
        sourceLanguageCode: c.sourceLanguageCode,
        aliasType: c.aliasType,
        confidence: c.confidence,
        reviewStatus: c.reviewStatus,
        provenance: c.provenance,
        evidence: c.evidence,
        actor: "usr_1",
        policyVersion: "alias-source-governance-v1",
      },
      timing: { recordedAt: "2026-06-16T00:00:00.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO catalog_item_aliases");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (alias_hash) DO UPDATE");
  });

  it("projects a proposed reference-record alias into catalog_reference_record_aliases", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogAliasProjectionHandlers({ query });
    const c = candidate("reference-record");

    await handlers["catalog.alias.proposed"]?.({
      streamId: catalogAliasStreamId(c.aliasHash),
      data: {
        aliasHash: c.aliasHash,
        target: c.target,
        aliasText: c.aliasText,
        normalizedAliasText: c.normalizedAliasText,
        aliasLanguageCode: c.aliasLanguageCode,
        sourceLanguageCode: c.sourceLanguageCode,
        aliasType: c.aliasType,
        confidence: c.confidence,
        reviewStatus: c.reviewStatus,
        provenance: c.provenance,
        evidence: c.evidence,
        actor: "system",
        policyVersion: "alias-source-governance-v1",
      },
      timing: { recordedAt: "2026-06-16T00:00:00.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO catalog_reference_record_aliases");
  });

  it("flips review_status in place on revoke without deleting (idempotent removal)", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogAliasProjectionHandlers({ query });
    const c = candidate("catalog-item");

    await handlers["catalog.alias.revoked"]?.({
      streamId: catalogAliasStreamId(c.aliasHash),
      data: {
        reviewStatus: "revoked",
        actor: "usr_3",
        reason: "evidence changed",
        policyVersion: "alias-source-governance-v1",
      },
      timing: { recordedAt: "2026-06-16T01:00:00.000Z" },
    } as never);

    // The review status flips in place on both target tables; never a DELETE.
    const reviewUpdates = query.mock.calls.filter(
      (call) => call[0].includes("SET") && call[0].includes("review_status = $2"),
    );
    expect(reviewUpdates).toHaveLength(2);
    for (const call of reviewUpdates) {
      expect(call[0]).toContain("UPDATE");
      expect(call[0]).not.toContain("DELETE");
      expect(call[1]?.[0]).toBe(c.aliasHash);
      expect(call[1]?.[1]).toBe("revoked");
    }
    // No DELETE is issued anywhere in the handler.
    for (const call of query.mock.calls) {
      expect(call[0]).not.toContain("DELETE");
    }
  });

  it("enqueues resolved-alias recompute when an alias review status changes (#1910)", async () => {
    // The revoke handler routes the alias hash to its Catalog Item target and
    // enqueues bounded recompute so the resolved fact can drop the alias.
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("SELECT catalog_item_id FROM catalog_item_aliases")) {
        return { rows: [{ catalog_item_id: "cat_1" }] };
      }
      return { rows: [] };
    });
    const handlers = buildCatalogAliasProjectionHandlers({ query });
    const c = candidate("catalog-item");

    await handlers["catalog.alias.revoked"]?.({
      streamId: catalogAliasStreamId(c.aliasHash),
      data: {
        reviewStatus: "revoked",
        actor: "usr_3",
        reason: "evidence changed",
        policyVersion: "alias-source-governance-v1",
      },
      timing: { recordedAt: "2026-06-16T01:00:00.000Z" },
    } as never);

    const enqueue = query.mock.calls.find((call) => call[0].includes("INSERT INTO catalog_item_alias_recompute_work"));
    expect(enqueue).toBeDefined();
    expect(enqueue?.[1]?.[0]).toEqual(["cat_1"]);
    expect(enqueue?.[1]?.[1]).toBe("alias-revoked");
  });

  it("enqueues recompute for a reference-record target on a proposed alias (#1910)", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogAliasProjectionHandlers({ query });
    const c = candidate("reference-record");

    await handlers["catalog.alias.proposed"]?.({
      streamId: catalogAliasStreamId(c.aliasHash),
      data: {
        aliasHash: c.aliasHash,
        target: c.target,
        aliasText: c.aliasText,
        normalizedAliasText: c.normalizedAliasText,
        aliasLanguageCode: c.aliasLanguageCode,
        sourceLanguageCode: c.sourceLanguageCode,
        aliasType: c.aliasType,
        confidence: c.confidence,
        reviewStatus: c.reviewStatus,
        provenance: c.provenance,
        evidence: c.evidence,
        actor: "system",
        policyVersion: "alias-source-governance-v1",
      },
      timing: { recordedAt: "2026-06-16T00:00:00.000Z" },
    } as never);

    const enqueue = query.mock.calls.find((call) =>
      call[0].includes("INSERT INTO catalog_reference_record_alias_recompute_work"),
    );
    expect(enqueue).toBeDefined();
    expect(enqueue?.[1]?.[0]).toEqual([c.target.targetId]);
    expect(enqueue?.[1]?.[1]).toBe("alias-proposed");
  });
});
