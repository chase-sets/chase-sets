import { describe, expect, it } from "vitest";
import { foldEvents } from "@chase-sets/event-core";
import { buildCatalogAliasCandidate } from "./alias";
import {
  catalogAliasStreamId,
  decideCatalogAlias,
  evolveCatalogAlias,
  initialCatalogAliasState,
  type CatalogAliasCommand,
  type CatalogAliasEvent,
  type CatalogAliasState,
} from "./domain";

function pendingCandidate() {
  return buildCatalogAliasCandidate({
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
  });
}

function autoAcceptedCandidate() {
  return buildCatalogAliasCandidate({
    target: { kind: "catalog-item", targetId: "cat_1", targetKey: "name" },
    aliasText: "Charizard",
    aliasLanguageCode: "en",
    aliasType: "official-equivalent",
    confidence: "exact",
    reviewStatus: "auto-accepted",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_2",
      sourceCategory: "official-english-source",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fp-1",
    },
    evidence: {},
  });
}

function apply(
  state: CatalogAliasState,
  command: CatalogAliasCommand,
): { state: CatalogAliasState; events: readonly CatalogAliasEvent[] } {
  const events = decideCatalogAlias(state, command);
  return { state: foldEvents(state, evolveCatalogAlias, events), events };
}

describe("Catalog Alias stream id", () => {
  it("derives a stable stream id from the alias hash", () => {
    const candidate = pendingCandidate();
    expect(catalogAliasStreamId(candidate.aliasHash)).toBe(`catalog.alias-${candidate.aliasHash}`);
  });
});

describe("Catalog Alias proposal", () => {
  it("proposes a pending alias", () => {
    const { state, events } = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate: pendingCandidate(),
      actor: "usr_1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("catalog.alias.proposed");
    expect(state.reviewStatus).toBe("pending");
    expect(state.aliasText).toBe("Dracaufeu");
    expect(state.lastAudit?.actor).toBe("usr_1");
  });

  it("proposes an auto-accepted alias from a governed source", () => {
    const { state } = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate: autoAcceptedCandidate(),
      actor: "system",
    });

    expect(state.reviewStatus).toBe("auto-accepted");
  });

  it("is idempotent when the same candidate is re-proposed unchanged", () => {
    const candidate = pendingCandidate();
    const { state } = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate,
      actor: "usr_1",
    });

    const replay = decideCatalogAlias(state, { type: "ProposeCatalogAlias", candidate, actor: "usr_1" });
    expect(replay).toHaveLength(0);
  });

  it("re-emits when re-proposed candidate carries fresher evidence", () => {
    const candidate = pendingCandidate();
    const { state } = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate,
      actor: "usr_1",
    });

    const refreshed = buildCatalogAliasCandidate({
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
      evidence: { sharedId: "base1-4", refreshed: true },
    });

    const replay = decideCatalogAlias(state, { type: "ProposeCatalogAlias", candidate: refreshed, actor: "usr_1" });
    expect(replay).toHaveLength(1);
  });
});

describe("Catalog Alias review lifecycle", () => {
  it("accepts a pending alias", () => {
    const proposed = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate: pendingCandidate(),
      actor: "usr_1",
    });
    const accepted = apply(proposed.state, { type: "AcceptCatalogAlias", actor: "usr_2", reason: "verified" });

    expect(accepted.state.reviewStatus).toBe("accepted");
    expect(accepted.state.lastAudit?.reason).toBe("verified");
  });

  it("rejects a pending alias and retains it as evidence", () => {
    const proposed = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate: pendingCandidate(),
      actor: "usr_1",
    });
    const rejected = apply(proposed.state, { type: "RejectCatalogAlias", actor: "usr_2", reason: "wrong card" });

    expect(rejected.state.reviewStatus).toBe("rejected");
    // Provenance/evidence are retained, not deleted.
    expect(rejected.state.provenance?.observationId).toBe("obs_1");
    expect(rejected.state.evidence).toEqual({ sharedId: "base1-4" });
  });

  it("acceptance is idempotent", () => {
    const accepted = apply(
      apply(initialCatalogAliasState, {
        type: "ProposeCatalogAlias",
        candidate: pendingCandidate(),
        actor: "usr_1",
      }).state,
      { type: "AcceptCatalogAlias", actor: "usr_2" },
    );

    const replay = decideCatalogAlias(accepted.state, { type: "AcceptCatalogAlias", actor: "usr_2" });
    expect(replay).toHaveLength(0);
  });
});

describe("Catalog Alias revocation", () => {
  it("revokes an accepted alias without losing provenance/audit history", () => {
    const accepted = apply(
      apply(initialCatalogAliasState, {
        type: "ProposeCatalogAlias",
        candidate: pendingCandidate(),
        actor: "usr_1",
      }).state,
      { type: "AcceptCatalogAlias", actor: "usr_2" },
    );

    const revoked = apply(accepted.state, {
      type: "RevokeCatalogAlias",
      actor: "usr_3",
      reason: "evidence changed",
    });

    expect(revoked.state.reviewStatus).toBe("revoked");
    expect(revoked.state.aliasText).toBe("Dracaufeu");
    expect(revoked.state.provenance?.observationId).toBe("obs_1");
    expect(revoked.state.lastAudit).toEqual({
      actor: "usr_3",
      reason: "evidence changed",
      policyVersion: "alias-source-governance-v1",
    });
  });

  it("revocation is idempotent (replayable removal)", () => {
    const revoked = apply(
      apply(
        apply(initialCatalogAliasState, {
          type: "ProposeCatalogAlias",
          candidate: autoAcceptedCandidate(),
          actor: "system",
        }).state,
        { type: "RevokeCatalogAlias", actor: "usr_3", reason: "decayed" },
      ).state,
      { type: "RevokeCatalogAlias", actor: "usr_3", reason: "decayed" },
    );

    expect(revoked.events).toHaveLength(0);
    expect(revoked.state.reviewStatus).toBe("revoked");
  });

  it("cannot revoke a pending alias (never trusted)", () => {
    const proposed = apply(initialCatalogAliasState, {
      type: "ProposeCatalogAlias",
      candidate: pendingCandidate(),
      actor: "usr_1",
    });

    expect(() =>
      decideCatalogAlias(proposed.state, { type: "RevokeCatalogAlias", actor: "usr_3", reason: "x" }),
    ).toThrow(/Only accepted or auto-accepted aliases can be revoked/);
  });

  it("re-accepts a revoked alias when evidence is restored", () => {
    const revoked = apply(
      apply(
        apply(initialCatalogAliasState, {
          type: "ProposeCatalogAlias",
          candidate: autoAcceptedCandidate(),
          actor: "system",
        }).state,
        { type: "RevokeCatalogAlias", actor: "usr_3", reason: "decayed" },
      ).state,
      { type: "AcceptCatalogAlias", actor: "usr_4", reason: "restored" },
    );

    expect(revoked.state.reviewStatus).toBe("accepted");
  });
});
