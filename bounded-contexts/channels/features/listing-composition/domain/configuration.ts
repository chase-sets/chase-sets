import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type {
  ChannelCommandRefusal,
  ChannelMappingConfidenceTier,
  ChannelMappingDimension,
  ChannelMappingReviewStatus,
  ChannelPublicationSettings,
} from "./contracts";
import { canonicalJson } from "./canonical";

export type ChannelMappingCandidate = Readonly<{
  dimension: ChannelMappingDimension;
  sourceKey: string;
  proposedTargetKey: string | null;
  confidenceTier: ChannelMappingConfidenceTier;
  evidence: Readonly<{ listingId: string; derivedFrom: string }>;
}>;

export type ChannelConfigurationMapping = Readonly<{
  dimension: ChannelMappingDimension;
  sourceKey: string;
  targetKey: string | null;
  confidenceTier: ChannelMappingConfidenceTier;
  reviewStatus: ChannelMappingReviewStatus;
  provenance: "compose-discovered" | "export-discovered" | "operator";
  evidence: Readonly<{ listingId: string; derivedFrom: string }>;
}>;

export type ChannelPublicationConfigurationState = Readonly<{
  connectionId: string | null;
  settings: ChannelPublicationSettings | null;
  mappings: Readonly<Record<string, ChannelConfigurationMapping>>;
}>;

export const initialChannelPublicationConfigurationState: ChannelPublicationConfigurationState = {
  connectionId: null,
  settings: null,
  mappings: {},
};

export type ChannelPublicationSettingsReplacedEvent = DomainEvent<
  "channels.channel-publication-configuration.settings-replaced",
  Readonly<{ connectionId: string; settings: ChannelPublicationSettings }>
>;
export type ChannelMappingCandidateRecordedEvent = DomainEvent<
  "channels.channel-publication-configuration.mapping-candidate-recorded",
  Readonly<{
    connectionId: string;
    provenance: "compose-discovered" | "export-discovered";
    candidates: readonly ChannelMappingCandidate[];
  }>
>;
export type ChannelMappingReviewDecidedEvent = DomainEvent<
  "channels.channel-publication-configuration.mapping-review-decided",
  Readonly<{
    connectionId: string;
    dimension: ChannelMappingDimension;
    sourceKey: string;
    targetKey: string | null;
    confidenceTier: ChannelMappingConfidenceTier;
    reviewStatus: ChannelMappingReviewStatus;
    evidence: Readonly<{ listingId: string; derivedFrom: string }>;
  }>
>;
export type ChannelPublicationConfigurationEvent =
  | ChannelPublicationSettingsReplacedEvent
  | ChannelMappingCandidateRecordedEvent
  | ChannelMappingReviewDecidedEvent;

export type ConfigurationDecision =
  | Readonly<{ kind: "append"; event: ChannelPublicationConfigurationEvent }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; code: ChannelCommandRefusal }>;

export function decideReplaceChannelPublicationSettings(
  state: ChannelPublicationConfigurationState,
  connectionId: string,
  settings: ChannelPublicationSettings,
): ConfigurationDecision {
  if (state.settings && canonicalJson(state.settings) === canonicalJson(settings)) return { kind: "unchanged" };
  return {
    kind: "append",
    event: { type: "channels.channel-publication-configuration.settings-replaced", data: { connectionId, settings } },
  };
}

export function decideRecordChannelMappingCandidates(
  state: ChannelPublicationConfigurationState,
  connectionId: string,
  provenance: "compose-discovered" | "export-discovered",
  candidates: readonly ChannelMappingCandidate[],
): ConfigurationDecision {
  const unseen = candidates.filter(
    (candidate) => state.mappings[mappingKey(candidate.dimension, candidate.sourceKey)] === undefined,
  );
  if (unseen.length === 0) return { kind: "unchanged" };
  return {
    kind: "append",
    event: {
      type: "channels.channel-publication-configuration.mapping-candidate-recorded",
      data: { connectionId, provenance, candidates: unseen },
    },
  };
}

export function decideChannelMappingReview(
  state: ChannelPublicationConfigurationState,
  input: Readonly<{
    connectionId: string;
    dimension: ChannelMappingDimension;
    sourceKey: string;
    decision: "accept" | "auto-accept" | "reject" | "revoke";
    targetKey: string | null;
  }>,
): ConfigurationDecision {
  const current = state.mappings[mappingKey(input.dimension, input.sourceKey)];
  if (!current) return { kind: "refused", code: "unknown-mapping" };
  if ((input.decision === "accept" || input.decision === "auto-accept") && input.targetKey === null) {
    return { kind: "refused", code: "target-required" };
  }
  const nextStatus = transitionMappingReview(current.reviewStatus, input.decision);
  if (nextStatus.startsWith("refused:")) {
    return { kind: "refused", code: String(nextStatus).replace("refused:", "") as ChannelCommandRefusal };
  }
  if (
    nextStatus !== "proposed" &&
    nextStatus !== "accepted" &&
    nextStatus !== "auto-accepted" &&
    nextStatus !== "rejected" &&
    nextStatus !== "revoked"
  )
    throw new Error("Unhandled Channel Mapping review transition.");
  return {
    kind: "append",
    event: {
      type: "channels.channel-publication-configuration.mapping-review-decided",
      data: {
        connectionId: input.connectionId,
        dimension: input.dimension,
        sourceKey: input.sourceKey,
        targetKey: nextStatus === "accepted" || nextStatus === "auto-accepted" ? input.targetKey : null,
        confidenceTier: input.decision === "auto-accept" ? current.confidenceTier : "manual",
        reviewStatus: nextStatus,
        evidence: current.evidence,
      },
    },
  };
}

type ReviewTransition = ChannelMappingReviewStatus | `refused:${ChannelCommandRefusal}`;

export function transitionMappingReview(
  current: ChannelMappingReviewStatus,
  decision: "accept" | "auto-accept" | "reject" | "revoke",
): ReviewTransition {
  const table: Record<ChannelMappingReviewStatus, Record<typeof decision, ReviewTransition>> = {
    proposed: { accept: "accepted", "auto-accept": "auto-accepted", reject: "rejected", revoke: "refused:not-decided" },
    accepted: {
      accept: "refused:already-decided",
      "auto-accept": "refused:already-decided",
      reject: "rejected",
      revoke: "revoked",
    },
    "auto-accepted": {
      accept: "accepted",
      "auto-accept": "refused:already-decided",
      reject: "rejected",
      revoke: "revoked",
    },
    rejected: {
      accept: "accepted",
      "auto-accept": "refused:not-proposed",
      reject: "refused:already-decided",
      revoke: "refused:not-accepted",
    },
    revoked: {
      accept: "accepted",
      "auto-accept": "refused:not-proposed",
      reject: "rejected",
      revoke: "refused:already-revoked",
    },
  };
  return table[current][decision];
}

export const evolveChannelPublicationConfiguration: AggregateEvolver<
  ChannelPublicationConfigurationState,
  ChannelPublicationConfigurationEvent
> = (state, event) => {
  switch (event.type) {
    case "channels.channel-publication-configuration.settings-replaced":
      return { ...state, connectionId: event.data.connectionId, settings: event.data.settings };
    case "channels.channel-publication-configuration.mapping-candidate-recorded": {
      const mappings = { ...state.mappings };
      for (const candidate of event.data.candidates) {
        mappings[mappingKey(candidate.dimension, candidate.sourceKey)] = {
          dimension: candidate.dimension,
          sourceKey: candidate.sourceKey,
          targetKey: candidate.proposedTargetKey,
          confidenceTier: candidate.confidenceTier,
          reviewStatus: "proposed",
          provenance: event.data.provenance,
          evidence: candidate.evidence,
        };
      }
      return { ...state, connectionId: event.data.connectionId, mappings };
    }
    case "channels.channel-publication-configuration.mapping-review-decided":
      return {
        ...state,
        connectionId: event.data.connectionId,
        mappings: {
          ...state.mappings,
          [mappingKey(event.data.dimension, event.data.sourceKey)]: {
            dimension: event.data.dimension,
            sourceKey: event.data.sourceKey,
            targetKey: event.data.targetKey,
            confidenceTier: event.data.confidenceTier,
            reviewStatus: event.data.reviewStatus,
            provenance: "operator",
            evidence: event.data.evidence,
          },
        },
      };
  }
};

export function mappingKey(dimension: ChannelMappingDimension, sourceKey: string): string {
  return `${dimension}\u0000${sourceKey}`;
}
