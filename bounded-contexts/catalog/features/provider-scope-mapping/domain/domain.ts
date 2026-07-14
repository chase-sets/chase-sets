import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject } from "@chase-sets/primitives/json";
import { assert, assertNever } from "../../../support/runtime-support/common";
import {
  buildProviderScopeMappingCandidate,
  computeProviderScopeMappingId,
  isProviderScopeMappingAccepted,
  normalizeProviderScopeMappingIdentity,
  type ProviderScopeMappingCandidate,
  type ProviderScopeMappingConfidenceTier,
  type ProviderScopeMappingCoordinates,
  type ProviderScopeMappingIdentity,
  type ProviderScopeMappingProvenance,
  type ProviderScopeMappingReviewStatus,
} from "./mapping";

export const CATALOG_PROVIDER_SCOPE_MAPPING_POLICY_VERSION = "provider-scope-mapping-v1";
export const CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX = "catalog.provider-scope-mapping-";

export function providerScopeMappingStreamId(identity: ProviderScopeMappingIdentity): string {
  return `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}${computeProviderScopeMappingId(identity)}`;
}

export type ProviderScopeMappingAudit = Readonly<{
  actor: string;
  reason: string | null;
  policyVersion: string;
}>;

export type ProviderScopeMappingState = Readonly<{
  mappingId: string | null;
  scopeRecordId: string | null;
  providerKey: string | null;
  unitKey: string | null;
  coordinates: ProviderScopeMappingCoordinates | null;
  confidence: ProviderScopeMappingConfidenceTier | null;
  reviewStatus: ProviderScopeMappingReviewStatus | null;
  provenance: ProviderScopeMappingProvenance | null;
  evidence: JsonObject;
  lastAudit: ProviderScopeMappingAudit | null;
}>;

export const initialProviderScopeMappingState: ProviderScopeMappingState = {
  mappingId: null,
  scopeRecordId: null,
  providerKey: null,
  unitKey: null,
  coordinates: null,
  confidence: null,
  reviewStatus: null,
  provenance: null,
  evidence: {},
  lastAudit: null,
};

export type ProposeProviderScopeMappingCommand = Readonly<{
  type: "ProposeProviderScopeMapping";
  candidate: ProviderScopeMappingCandidate;
  actor: string;
}>;

export type AcceptProviderScopeMappingCommand = Readonly<{
  type: "AcceptProviderScopeMapping";
  actor: string;
  reason?: string | null;
}>;

export type RejectProviderScopeMappingCommand = Readonly<{
  type: "RejectProviderScopeMapping";
  actor: string;
  reason: string;
}>;

export type RevokeProviderScopeMappingCommand = Readonly<{
  type: "RevokeProviderScopeMapping";
  actor: string;
  reason: string;
}>;

export type ProviderScopeMappingCommand =
  | ProposeProviderScopeMappingCommand
  | AcceptProviderScopeMappingCommand
  | RejectProviderScopeMappingCommand
  | RevokeProviderScopeMappingCommand;

type ProviderScopeMappingProposedData = JsonObject &
  Readonly<{
    mappingId: string;
    scopeRecordId: string;
    providerKey: string;
    unitKey: string;
    coordinates: ProviderScopeMappingCoordinates;
    confidence: ProviderScopeMappingConfidenceTier;
    reviewStatus: ProviderScopeMappingReviewStatus;
    provenance: ProviderScopeMappingProvenance;
    evidence: JsonObject;
    actor: string;
    policyVersion: string;
  }>;

type ProviderScopeMappingReviewData = JsonObject &
  Readonly<{
    reviewStatus: ProviderScopeMappingReviewStatus;
    actor: string;
    reason: string | null;
    policyVersion: string;
  }>;

export type ProviderScopeMappingProposedEvent = DomainEvent<
  "catalog.provider-scope-mapping.proposed",
  ProviderScopeMappingProposedData
>;
export type ProviderScopeMappingAcceptedEvent = DomainEvent<
  "catalog.provider-scope-mapping.accepted",
  ProviderScopeMappingReviewData
>;
export type ProviderScopeMappingRejectedEvent = DomainEvent<
  "catalog.provider-scope-mapping.rejected",
  ProviderScopeMappingReviewData
>;
export type ProviderScopeMappingRevokedEvent = DomainEvent<
  "catalog.provider-scope-mapping.revoked",
  ProviderScopeMappingReviewData
>;

export type ProviderScopeMappingEvent =
  | ProviderScopeMappingProposedEvent
  | ProviderScopeMappingAcceptedEvent
  | ProviderScopeMappingRejectedEvent
  | ProviderScopeMappingRevokedEvent;

export const decideProviderScopeMapping: AggregateDecider<
  ProviderScopeMappingState,
  ProviderScopeMappingCommand,
  ProviderScopeMappingEvent
> = (state, command) => {
  switch (command.type) {
    case "ProposeProviderScopeMapping": {
      const candidate = command.candidate;
      assert(command.actor.trim().length > 0, "Proposing a Provider Scope Mapping requires an actor.");
      assert(candidate.mappingId === computeProviderScopeMappingId(candidate), "Provider Scope Mapping id is invalid.");

      // Provider refreshes may carry newer labels, hashes, or scan provenance,
      // but review disposition is durable. A refresh must never downgrade an
      // accepted mapping or resurrect a rejected/revoked proposal.
      if (
        state.reviewStatus === "accepted" ||
        state.reviewStatus === "auto-accepted" ||
        state.reviewStatus === "rejected" ||
        state.reviewStatus === "revoked"
      ) {
        return [];
      }

      if (isIdenticalProposal(state, candidate)) {
        return [];
      }

      return [
        {
          type: "catalog.provider-scope-mapping.proposed",
          data: {
            mappingId: candidate.mappingId,
            scopeRecordId: candidate.scopeRecordId,
            providerKey: candidate.providerKey,
            unitKey: candidate.unitKey,
            coordinates: candidate.coordinates,
            confidence: candidate.confidence,
            reviewStatus: candidate.reviewStatus,
            provenance: candidate.provenance,
            evidence: candidate.evidence,
            actor: command.actor.trim(),
            policyVersion: CATALOG_PROVIDER_SCOPE_MAPPING_POLICY_VERSION,
          },
        },
      ];
    }
    case "AcceptProviderScopeMapping": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Accepting a Provider Scope Mapping requires an actor.");
      if (isProviderScopeMappingAccepted(state.reviewStatus)) {
        return [];
      }
      assert(
        state.reviewStatus === "proposed" || state.reviewStatus === "rejected" || state.reviewStatus === "revoked",
        `Cannot accept a Provider Scope Mapping in '${state.reviewStatus}' state.`,
      );
      return [
        {
          type: "catalog.provider-scope-mapping.accepted",
          data: {
            reviewStatus: "accepted",
            actor: command.actor.trim(),
            reason: command.reason?.trim() || null,
            policyVersion: CATALOG_PROVIDER_SCOPE_MAPPING_POLICY_VERSION,
          },
        },
      ];
    }
    case "RejectProviderScopeMapping": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Rejecting a Provider Scope Mapping requires an actor.");
      assert(command.reason.trim().length > 0, "Rejecting a Provider Scope Mapping requires a reason.");
      if (state.reviewStatus === "rejected") {
        return [];
      }
      assert(
        state.reviewStatus === "proposed",
        `Only proposed Provider Scope Mappings can be rejected; mapping is '${state.reviewStatus}'.`,
      );
      return [
        {
          type: "catalog.provider-scope-mapping.rejected",
          data: {
            reviewStatus: "rejected",
            actor: command.actor.trim(),
            reason: command.reason.trim(),
            policyVersion: CATALOG_PROVIDER_SCOPE_MAPPING_POLICY_VERSION,
          },
        },
      ];
    }
    case "RevokeProviderScopeMapping": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Revoking a Provider Scope Mapping requires an actor.");
      assert(command.reason.trim().length > 0, "Revoking a Provider Scope Mapping requires a reason.");
      if (state.reviewStatus === "revoked") {
        return [];
      }
      assert(
        isProviderScopeMappingAccepted(state.reviewStatus),
        `Only accepted or auto-accepted Provider Scope Mappings can be revoked; mapping is '${state.reviewStatus}'.`,
      );
      return [
        {
          type: "catalog.provider-scope-mapping.revoked",
          data: {
            reviewStatus: "revoked",
            actor: command.actor.trim(),
            reason: command.reason.trim(),
            policyVersion: CATALOG_PROVIDER_SCOPE_MAPPING_POLICY_VERSION,
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveProviderScopeMapping: AggregateEvolver<ProviderScopeMappingState, ProviderScopeMappingEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.provider-scope-mapping.proposed":
      return {
        ...state,
        mappingId: event.data.mappingId,
        scopeRecordId: event.data.scopeRecordId,
        providerKey: event.data.providerKey,
        unitKey: event.data.unitKey,
        coordinates: event.data.coordinates,
        confidence: event.data.confidence,
        reviewStatus: event.data.reviewStatus,
        provenance: event.data.provenance,
        evidence: event.data.evidence,
        lastAudit: {
          actor: event.data.actor,
          reason: null,
          policyVersion: event.data.policyVersion,
        },
      };
    case "catalog.provider-scope-mapping.accepted":
    case "catalog.provider-scope-mapping.rejected":
    case "catalog.provider-scope-mapping.revoked":
      return {
        ...state,
        reviewStatus: event.data.reviewStatus,
        lastAudit: {
          actor: event.data.actor,
          reason: event.data.reason,
          policyVersion: event.data.policyVersion,
        },
      };
    default:
      return assertNever(event);
  }
};

function isIdenticalProposal(state: ProviderScopeMappingState, candidate: ProviderScopeMappingCandidate): boolean {
  if (state.mappingId !== candidate.mappingId) {
    return false;
  }

  const proposalMatches =
    state.confidence === candidate.confidence &&
    JSON.stringify(state.coordinates) === JSON.stringify(candidate.coordinates) &&
    JSON.stringify(state.provenance) === JSON.stringify(candidate.provenance) &&
    JSON.stringify(state.evidence) === JSON.stringify(candidate.evidence);

  if (!proposalMatches) {
    return false;
  }

  return state.reviewStatus === candidate.reviewStatus;
}

function requireProposed(
  state: ProviderScopeMappingState,
): asserts state is ProviderScopeMappingState & { reviewStatus: ProviderScopeMappingReviewStatus } {
  assert(state.mappingId !== null && state.reviewStatus !== null, "Provider Scope Mapping must be proposed first.");
}

export { buildProviderScopeMappingCandidate, normalizeProviderScopeMappingIdentity };
export type { ProviderScopeMappingCandidate };
