import { describe, expect, it, vi } from "vitest";
import { buildProviderScopeMappingCandidate } from "../domain/mapping";
import { providerScopeMappingStreamId } from "../domain/domain";
import { buildProviderScopeMappingProjectionHandlers } from "./projection";

function candidate() {
  return buildProviderScopeMappingCandidate({
    scopeRecordId: "ref_expansion_paldean_fates",
    providerKey: "tcgdex",
    unitKey: "pokemon-card-import",
    coordinates: {
      productLineId: "pokemon",
      seriesId: "sv",
      setId: "sv4-5",
      setName: "Paldean Fates",
      language: {
        languageCode: "en",
        providerLanguageCode: "en",
        providerLocale: "en-US",
      },
    },
    confidence: "high",
    reviewStatus: "proposed",
    provenance: {
      source: "operator",
      sourceId: "ticket-3792",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.07.03",
      mappingFingerprint: "fp-1",
    },
    evidence: { sharedProviderSet: true },
  });
}

describe("Provider Scope Mapping projection", () => {
  it("projects proposed mapping coordinates by scope/provider/unit", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildProviderScopeMappingProjectionHandlers({ query });
    const c = candidate();

    await handlers["catalog.provider-scope-mapping.proposed"]?.({
      streamId: providerScopeMappingStreamId(c),
      data: {
        mappingId: c.mappingId,
        scopeRecordId: c.scopeRecordId,
        providerKey: c.providerKey,
        unitKey: c.unitKey,
        coordinates: c.coordinates,
        confidence: c.confidence,
        reviewStatus: c.reviewStatus,
        provenance: c.provenance,
        evidence: c.evidence,
        actor: "usr_1",
        policyVersion: "provider-scope-mapping-v1",
      },
      timing: { recordedAt: "2026-07-03T12:00:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain("INSERT INTO catalog_provider_scope_mappings");
    expect(sql).toContain("ON CONFLICT (mapping_id) DO UPDATE");
    expect(params?.[0]).toBe(c.mappingId);
    expect(params?.[1]).toBe("ref_expansion_paldean_fates");
    expect(params?.[2]).toBe("tcgdex");
    expect(params?.[3]).toBe("pokemon-card-import");
    expect(params?.[6]).toBe("sv4-5");
    expect(params?.[8]).toBe(JSON.stringify(c.coordinates.language));
  });

  it("flips review status in place for accepted and revoked mappings", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildProviderScopeMappingProjectionHandlers({ query });
    const c = candidate();

    await handlers["catalog.provider-scope-mapping.accepted"]?.({
      streamId: providerScopeMappingStreamId(c),
      data: {
        reviewStatus: "accepted",
        actor: "usr_2",
        reason: "verified",
        policyVersion: "provider-scope-mapping-v1",
      },
      timing: { recordedAt: "2026-07-03T12:01:00.000Z" },
    } as never);
    await handlers["catalog.provider-scope-mapping.revoked"]?.({
      streamId: providerScopeMappingStreamId(c),
      data: {
        reviewStatus: "revoked",
        actor: "usr_3",
        reason: "provider retired",
        policyVersion: "provider-scope-mapping-v1",
      },
      timing: { recordedAt: "2026-07-03T12:02:00.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("UPDATE catalog_provider_scope_mappings");
    expect(query.mock.calls[0]?.[1]).toEqual([
      c.mappingId,
      "accepted",
      "usr_2",
      "verified",
      "provider-scope-mapping-v1",
      "2026-07-03T12:01:00.000Z",
    ]);
    expect(query.mock.calls[1]?.[1]?.[1]).toBe("revoked");
    for (const call of query.mock.calls) {
      expect(call[0]).not.toContain("DELETE");
    }
  });
});
