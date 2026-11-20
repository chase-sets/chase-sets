import { describe, expect, it } from "vitest";
import { foldEvents } from "@chase-sets/event-core";
import {
  buildProviderScopeMappingCandidate,
  decideProviderScopeMapping,
  evolveProviderScopeMapping,
  initialProviderScopeMappingState,
  providerScopeMappingStreamId,
  type ProviderScopeMappingCommand,
  type ProviderScopeMappingEvent,
  type ProviderScopeMappingState,
} from "./domain";
import type { BuildProviderScopeMappingCandidateInput } from "./mapping";

function mappingCandidate(overrides: Partial<BuildProviderScopeMappingCandidateInput> = {}) {
  const base: BuildProviderScopeMappingCandidateInput = {
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
      source: "scope-registry-backfill",
      sourceId: "obs_scope_1",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.07.03",
      mappingFingerprint: "fp-1",
    },
    evidence: { providerSetUrl: "https://example.test/sv4-5" },
  };

  return buildProviderScopeMappingCandidate({
    ...base,
    ...overrides,
    coordinates: {
      ...base.coordinates,
      ...overrides.coordinates,
      language: {
        ...base.coordinates.language,
        ...overrides.coordinates?.language,
      },
    },
    provenance: {
      ...base.provenance,
      ...overrides.provenance,
    },
  });
}

function apply(
  state: ProviderScopeMappingState,
  command: ProviderScopeMappingCommand,
): { state: ProviderScopeMappingState; events: readonly ProviderScopeMappingEvent[] } {
  const events = decideProviderScopeMapping(state, command);
  return { state: foldEvents(state, evolveProviderScopeMapping, events), events };
}

describe("Provider Scope Mapping identity", () => {
  it.each(["\uFEFFSynthetic Set", "  Synthetic Set  ", "", null, undefined])(
    "preserves the exact TCGplayer set-name coordinate %j while normalizing owned keys",
    (setName) => {
      const candidate = mappingCandidate({
        providerKey: " TCGplayer ",
        unitKey: " TCGplayer:MTG:single-card:source-observation-import ",
        coordinates: { setName, language: { languageCode: " EN " } },
      });
      expect(candidate.coordinates.setName).toBe(setName ?? null);
      expect(candidate.providerKey).toBe("tcgplayer");
      expect(candidate.unitKey).toBe("tcgplayer:mtg:single-card:source-observation-import");
      expect(candidate.coordinates.language.languageCode).toBe("en");
    },
  );

  it("retains non-TCGplayer coordinate normalization", () => {
    expect(mappingCandidate({ coordinates: { setName: "  Synthetic Set  " } }).coordinates.setName).toBe(
      "Synthetic Set",
    );
  });

  it("derives a stable stream id from scope record, provider, and unit", () => {
    const candidate = mappingCandidate();
    expect(providerScopeMappingStreamId(candidate)).toBe(`catalog.provider-scope-mapping-${candidate.mappingId}`);
  });
});

describe("Provider Scope Mapping lifecycle", () => {
  it("supports propose, accept, reject, auto-accept, and revoke states", () => {
    const proposed = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate(),
      actor: "usr_1",
    });
    const accepted = apply(proposed.state, {
      type: "AcceptProviderScopeMapping",
      actor: "usr_2",
      reason: "provider ids verified",
    });

    expect(proposed.state.reviewStatus).toBe("proposed");
    expect(accepted.state.reviewStatus).toBe("accepted");
    expect(accepted.state.coordinates?.setId).toBe("sv4-5");

    const rejected = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate({ coordinates: { setId: "wrong-set" } }),
      actor: "usr_1",
    });
    expect(
      apply(rejected.state, { type: "RejectProviderScopeMapping", actor: "usr_2", reason: "wrong scope" }).state
        .reviewStatus,
    ).toBe("rejected");

    const autoAccepted = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate({ reviewStatus: "auto-accepted", confidence: "exact" }),
      actor: "system",
    });
    expect(autoAccepted.state.reviewStatus).toBe("auto-accepted");
  });

  it("revokes an accepted mapping without losing provider coordinates or provenance", () => {
    const accepted = apply(
      apply(initialProviderScopeMappingState, {
        type: "ProposeProviderScopeMapping",
        candidate: mappingCandidate(),
        actor: "usr_1",
      }).state,
      { type: "AcceptProviderScopeMapping", actor: "usr_2" },
    );

    const revoked = apply(accepted.state, {
      type: "RevokeProviderScopeMapping",
      actor: "usr_3",
      reason: "provider set id was retired",
    });

    expect(revoked.state.reviewStatus).toBe("revoked");
    expect(revoked.state.coordinates?.setName).toBe("Paldean Fates");
    expect(revoked.state.provenance?.sourceId).toBe("obs_scope_1");
    expect(revoked.state.lastAudit).toEqual({
      actor: "usr_3",
      reason: "provider set id was retired",
      policyVersion: "provider-scope-mapping-v1",
    });
  });

  it("is idempotent when an identical mapping is re-proposed", () => {
    const candidate = mappingCandidate();
    const proposed = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate,
      actor: "usr_1",
    });

    expect(
      decideProviderScopeMapping(proposed.state, { type: "ProposeProviderScopeMapping", candidate, actor: "usr_1" }),
    ).toHaveLength(0);
  });

  it("is idempotent after persisted proposal objects are reloaded with different key order", () => {
    const candidate = mappingCandidate({ evidence: { nested: { first: 1, second: 2 }, ordered: ["first", "second"] } });
    const proposed = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate,
      actor: "usr_1",
    });
    const storedEvents: ProviderScopeMappingEvent[] = JSON.parse(
      JSON.stringify(proposed.events, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    const reloaded = foldEvents(initialProviderScopeMappingState, evolveProviderScopeMapping, storedEvents);
    expect(reloaded).toEqual(proposed.state);
    expect(JSON.stringify(reloaded.coordinates)).not.toBe(JSON.stringify(candidate.coordinates));
    expect(JSON.stringify(reloaded.provenance)).not.toBe(JSON.stringify(candidate.provenance));
    expect(JSON.stringify(reloaded.evidence)).not.toBe(JSON.stringify(candidate.evidence));
    expect(
      decideProviderScopeMapping(reloaded, { type: "ProposeProviderScopeMapping", candidate, actor: "usr_1" }),
    ).toEqual([]);
  });

  it.each<Partial<BuildProviderScopeMappingCandidateInput>>([
    { coordinates: { setName: "Paldean Fates (updated label)" } },
    { coordinates: { language: { providerLocale: "en-GB" } } },
    { provenance: { source: "scope-registry-backfill", sourceId: "obs_scope_2" } },
    { evidence: { nested: { first: 1, second: 3 }, ordered: ["first", "second"] } },
    { evidence: { nested: { first: 1, second: 2 }, ordered: ["second", "first"] } },
    { confidence: "candidate" },
  ])("refreshes a proposed mapping when its values change: %j", (overrides) => {
    const proposed = apply(initialProviderScopeMappingState, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate({ evidence: { nested: { first: 1, second: 2 }, ordered: ["first", "second"] } }),
      actor: "usr_1",
    });
    const candidate = mappingCandidate({ evidence: proposed.state.evidence ?? {}, ...overrides });
    const refreshed = apply(proposed.state, { type: "ProposeProviderScopeMapping", candidate, actor: "usr_1" });
    expect(refreshed.events).toHaveLength(1);
    expect(refreshed.state).toMatchObject({
      coordinates: candidate.coordinates,
      provenance: candidate.provenance,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
    });
  });

  it("does not downgrade or duplicate an accepted mapping when changed provider evidence is observed again", () => {
    const candidate = mappingCandidate();
    const accepted = apply(
      apply(initialProviderScopeMappingState, {
        type: "ProposeProviderScopeMapping",
        candidate,
        actor: "usr_1",
      }).state,
      { type: "AcceptProviderScopeMapping", actor: "usr_2" },
    );

    const replay = decideProviderScopeMapping(accepted.state, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate({
        coordinates: { setName: "Paldean Fates (updated label)" },
        provenance: { source: "scope-registry-backfill", sourceId: "obs_scope_2", mappingFingerprint: "fp-2" },
        evidence: { providerSetUrl: "https://example.test/sv4-5-v2" },
      }),
      actor: "system",
    });

    expect(replay).toHaveLength(0);
    expect(accepted.state.reviewStatus).toBe("accepted");
  });

  it("does not resurrect a rejected mapping when changed provider evidence is observed again", () => {
    const candidate = mappingCandidate();
    const rejected = apply(
      apply(initialProviderScopeMappingState, {
        type: "ProposeProviderScopeMapping",
        candidate,
        actor: "usr_1",
      }).state,
      { type: "RejectProviderScopeMapping", actor: "usr_2", reason: "wrong provider scope" },
    );

    const replay = decideProviderScopeMapping(rejected.state, {
      type: "ProposeProviderScopeMapping",
      candidate: mappingCandidate({
        coordinates: { setName: "Paldean Fates (updated label)" },
        provenance: { source: "scope-registry-backfill", sourceId: "obs_scope_2", mappingFingerprint: "fp-2" },
        evidence: { providerSetUrl: "https://example.test/sv4-5-v2" },
      }),
      actor: "system",
    });

    expect(replay).toHaveLength(0);
    expect(rejected.state.reviewStatus).toBe("rejected");
  });
});
