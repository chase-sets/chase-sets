import { describe, expect, it } from "vitest";
import {
  decideChannelMappingReview,
  decideRecordChannelMappingCandidates,
  evolveChannelPublicationConfiguration,
  initialChannelPublicationConfigurationState,
  transitionMappingReview,
  type ChannelMappingCandidate,
} from "../domain/configuration";
import type { ChannelMappingReviewStatus } from "../domain/contracts";

const candidate: ChannelMappingCandidate = {
  dimension: "category",
  sourceKey: "catalog-category:cards",
  proposedTargetKey: "trading-cards",
  confidenceTier: "high",
  evidence: { listingId: "listing-synthetic", derivedFrom: "assigned category cards" },
};

describe("channel-publication-configuration-commands", () => {
  it("executes the exhaustive review-state decision matrix", () => {
    const statuses: readonly ChannelMappingReviewStatus[] = [
      "proposed",
      "accepted",
      "auto-accepted",
      "rejected",
      "revoked",
    ];
    const decisions = ["accept", "auto-accept", "reject", "revoke"] as const;
    const expected = [
      ["accepted", "auto-accepted", "rejected", "refused:not-decided"],
      ["refused:already-decided", "refused:already-decided", "rejected", "revoked"],
      ["accepted", "refused:already-decided", "rejected", "revoked"],
      ["accepted", "refused:not-proposed", "refused:already-decided", "refused:not-accepted"],
      ["accepted", "refused:not-proposed", "rejected", "refused:already-revoked"],
    ];
    expect(
      statuses.flatMap((status, row) =>
        decisions.map((decision, column) => transitionMappingReview(status, decision) === expected[row]![column]),
      ),
    ).not.toContain(false);
  });

  it("records a candidate once and never overwrites a decided row", () => {
    const first = decideRecordChannelMappingCandidates(
      initialChannelPublicationConfigurationState,
      "connection-synthetic",
      "compose-discovered",
      [candidate],
    );
    if (first.kind !== "append") throw new Error("Expected candidate event.");
    let state = evolveChannelPublicationConfiguration(initialChannelPublicationConfigurationState, first.event);
    expect(
      decideRecordChannelMappingCandidates(state, "connection-synthetic", "export-discovered", [candidate]),
    ).toEqual({ kind: "unchanged" });
    const accepted = decideChannelMappingReview(state, {
      connectionId: "connection-synthetic",
      dimension: candidate.dimension,
      sourceKey: candidate.sourceKey,
      decision: "accept",
      targetKey: "cards",
    });
    if (accepted.kind !== "append") throw new Error("Expected decision event.");
    state = evolveChannelPublicationConfiguration(state, accepted.event);
    expect(
      decideRecordChannelMappingCandidates(state, "connection-synthetic", "compose-discovered", [
        { ...candidate, proposedTargetKey: "other" },
      ]),
    ).toEqual({ kind: "unchanged" });
  });

  it("requires a target and refuses unknown mappings", () => {
    expect(
      decideChannelMappingReview(initialChannelPublicationConfigurationState, {
        connectionId: "connection-synthetic",
        dimension: "category",
        sourceKey: "missing",
        decision: "accept",
        targetKey: "x",
      }),
    ).toEqual({ kind: "refused", code: "unknown-mapping" });
    const first = decideRecordChannelMappingCandidates(
      initialChannelPublicationConfigurationState,
      "connection-synthetic",
      "compose-discovered",
      [candidate],
    );
    if (first.kind !== "append") throw new Error("Expected candidate event.");
    const state = evolveChannelPublicationConfiguration(initialChannelPublicationConfigurationState, first.event);
    expect(
      decideChannelMappingReview(state, {
        connectionId: "connection-synthetic",
        dimension: candidate.dimension,
        sourceKey: candidate.sourceKey,
        decision: "accept",
        targetKey: null,
      }),
    ).toEqual({ kind: "refused", code: "target-required" });
  });
});
