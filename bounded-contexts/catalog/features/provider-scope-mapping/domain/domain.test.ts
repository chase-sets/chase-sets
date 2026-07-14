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
