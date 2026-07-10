import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject } from "@chase-sets/primitives/json";
import { CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION } from "../../source-observations/api/catalog-integration-data-governance";
import { assert, assertNever } from "../../../support/runtime-support/common";
import {
  buildCatalogAliasCandidate,
  isCatalogAliasPublishable,
  type CatalogAliasCandidate,
  type CatalogAliasConfidenceKey,
  type CatalogAliasProvenance,
  type CatalogAliasReviewStateKey,
  type CatalogAliasTarget,
  type CatalogAliasTypeKey,
} from "./alias";

// ---------------------------------------------------------------------------
// Catalog Alias aggregate
//
// The accepted-alias lifecycle as an event-sourced aggregate, keyed by the
// alias hash so re-proposing identical evidence is idempotent. The state
// machine follows the ADR review states:
//
//   (proposed) ──accept──▶ accepted ──revoke──▶ revoked
//        │                    ▲                    │
//        ├──auto-accept──▶ auto-accepted ──revoke─┘ (re-propose)
//        └──reject──▶ rejected
//
// Revocation never hard-deletes: the aggregate retains the full provenance and
// audit history, and downstream removal is driven by the published review
// state. Re-proposing a revoked or rejected alias is allowed (evidence
// changed) and returns it to `pending`/`auto-accepted` for re-review.
// ---------------------------------------------------------------------------

export const CATALOG_ALIAS_STREAM_PREFIX = "catalog.alias-";

export function catalogAliasStreamId(aliasHash: string): string {
  return `${CATALOG_ALIAS_STREAM_PREFIX}${aliasHash}`;
}

export type CatalogAliasAudit = Readonly<{
  /** Operator id for manual accept/reject/revoke; `"system"` for auto-accept. */
  actor: string;
  reason: string | null;
  policyVersion: string;
}>;

export type CatalogAliasState = Readonly<{
  aliasHash: string | null;
  target: CatalogAliasTarget | null;
  aliasText: string;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  sourceLanguageCode: string | null;
  aliasType: CatalogAliasTypeKey | null;
  confidence: CatalogAliasConfidenceKey | null;
  reviewStatus: CatalogAliasReviewStateKey | null;
  provenance: CatalogAliasProvenance | null;
  evidence: JsonObject;
  lastAudit: CatalogAliasAudit | null;
}>;

export const initialCatalogAliasState: CatalogAliasState = {
  aliasHash: null,
  target: null,
  aliasText: "",
  normalizedAliasText: "",
  aliasLanguageCode: "",
  sourceLanguageCode: null,
  aliasType: null,
  confidence: null,
  reviewStatus: null,
  provenance: null,
  evidence: {},
  lastAudit: null,
};

/**
 * Propose a Catalog Alias from a built candidate. The candidate carries its own
 * deterministic hash, so re-proposing identical evidence onto an existing alias
 * is idempotent (only evidence/confidence may refresh). `reviewStatus` on the
 * candidate decides whether it lands `pending` or `auto-accepted`.
 */
export type ProposeCatalogAliasCommand = Readonly<{
  type: "ProposeCatalogAlias";
  candidate: CatalogAliasCandidate;
  /** Actor recording the proposal; `"system"` for governed auto-accept. */
  actor: string;
}>;

export type AcceptCatalogAliasCommand = Readonly<{
  type: "AcceptCatalogAlias";
  actor: string;
  reason?: string | null;
}>;

export type RejectCatalogAliasCommand = Readonly<{
  type: "RejectCatalogAlias";
  actor: string;
  reason: string;
}>;

export type RevokeCatalogAliasCommand = Readonly<{
  type: "RevokeCatalogAlias";
  actor: string;
  reason: string;
}>;

export type CatalogAliasCommand =
  | ProposeCatalogAliasCommand
  | AcceptCatalogAliasCommand
  | RejectCatalogAliasCommand
  | RevokeCatalogAliasCommand;

type CatalogAliasProposedData = JsonObject &
  Readonly<{
    aliasHash: string;
    target: CatalogAliasTarget;
    aliasText: string;
    normalizedAliasText: string;
    aliasLanguageCode: string;
    sourceLanguageCode: string | null;
    aliasType: CatalogAliasTypeKey;
    confidence: CatalogAliasConfidenceKey;
    reviewStatus: CatalogAliasReviewStateKey;
    provenance: CatalogAliasProvenance;
    evidence: JsonObject;
    actor: string;
    policyVersion: string;
  }>;

export type CatalogAliasProposedEvent = DomainEvent<"catalog.alias.proposed", CatalogAliasProposedData>;

type CatalogAliasReviewData = JsonObject &
  Readonly<{
    reviewStatus: CatalogAliasReviewStateKey;
    actor: string;
    reason: string | null;
    policyVersion: string;
  }>;

export type CatalogAliasAcceptedEvent = DomainEvent<"catalog.alias.accepted", CatalogAliasReviewData>;
export type CatalogAliasRejectedEvent = DomainEvent<"catalog.alias.rejected", CatalogAliasReviewData>;
export type CatalogAliasRevokedEvent = DomainEvent<"catalog.alias.revoked", CatalogAliasReviewData>;

export type CatalogAliasEvent =
  | CatalogAliasProposedEvent
  | CatalogAliasAcceptedEvent
  | CatalogAliasRejectedEvent
  | CatalogAliasRevokedEvent;

export const decideCatalogAlias: AggregateDecider<CatalogAliasState, CatalogAliasCommand, CatalogAliasEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "ProposeCatalogAlias": {
      const candidate = command.candidate;
      assert(candidate.aliasHash.trim().length > 0, "Proposed alias requires a hash.");
      assert(command.actor.trim().length > 0, "Proposing an alias requires an actor.");

      // Re-proposal is idempotent against the same evidence: if nothing that the
      // accepted-alias fact depends on changed and the alias is already in a
      // terminal trusted/untrusted state, emit nothing.
      if (
        state.aliasHash === candidate.aliasHash &&
        state.reviewStatus === candidate.reviewStatus &&
        state.confidence === candidate.confidence &&
        JSON.stringify(state.evidence) === JSON.stringify(candidate.evidence) &&
        (state.target?.targetId ?? null) === candidate.target.targetId
      ) {
        return [];
      }

      return [
        {
          type: "catalog.alias.proposed",
          data: {
            aliasHash: candidate.aliasHash,
            target: candidate.target,
            aliasText: candidate.aliasText,
            normalizedAliasText: candidate.normalizedAliasText,
            aliasLanguageCode: candidate.aliasLanguageCode,
            sourceLanguageCode: candidate.sourceLanguageCode,
            aliasType: candidate.aliasType,
            confidence: candidate.confidence,
            reviewStatus: candidate.reviewStatus,
            provenance: candidate.provenance,
            evidence: candidate.evidence,
            actor: command.actor.trim(),
            policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
          },
        },
      ];
    }
    case "AcceptCatalogAlias": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Accepting an alias requires an actor.");
      // Idempotent: already accepted stays accepted.
      if (isCatalogAliasPublishable(state.reviewStatus)) {
        return [];
      }
      assert(
        state.reviewStatus === "pending" || state.reviewStatus === "revoked" || state.reviewStatus === "rejected",
        `Cannot accept an alias in '${state.reviewStatus}' state.`,
      );

      return [
        {
          type: "catalog.alias.accepted",
          data: {
            reviewStatus: "accepted",
            actor: command.actor.trim(),
            reason: command.reason?.trim() || null,
            policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
          },
        },
      ];
    }
    case "RejectCatalogAlias": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Rejecting an alias requires an actor.");
      assert(command.reason.trim().length > 0, "Rejecting an alias requires a reason.");
      // Idempotent: already rejected stays rejected.
      if (state.reviewStatus === "rejected") {
        return [];
      }

      return [
        {
          type: "catalog.alias.rejected",
          data: {
            reviewStatus: "rejected",
            actor: command.actor.trim(),
            reason: command.reason.trim(),
            policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
          },
        },
      ];
    }
    case "RevokeCatalogAlias": {
      requireProposed(state);
      assert(command.actor.trim().length > 0, "Revoking an alias requires an actor.");
      assert(command.reason.trim().length > 0, "Revoking an alias requires a reason.");
      // Idempotent: revoking an already-revoked alias is a no-op so downstream
      // removal can be replayed safely.
      if (state.reviewStatus === "revoked") {
        return [];
      }
      assert(
        isCatalogAliasPublishable(state.reviewStatus),
        `Only accepted or auto-accepted aliases can be revoked; alias is '${state.reviewStatus}'.`,
      );

      return [
        {
          type: "catalog.alias.revoked",
          data: {
            reviewStatus: "revoked",
            actor: command.actor.trim(),
            reason: command.reason.trim(),
            policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveCatalogAlias: AggregateEvolver<CatalogAliasState, CatalogAliasEvent> = (state, event) => {
  switch (event.type) {
    case "catalog.alias.proposed":
      return {
        ...state,
        aliasHash: event.data.aliasHash,
        target: event.data.target,
        aliasText: event.data.aliasText,
        normalizedAliasText: event.data.normalizedAliasText,
        aliasLanguageCode: event.data.aliasLanguageCode,
        sourceLanguageCode: event.data.sourceLanguageCode,
        aliasType: event.data.aliasType,
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
    case "catalog.alias.accepted":
    case "catalog.alias.rejected":
    case "catalog.alias.revoked":
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

function requireProposed(
  state: CatalogAliasState,
): asserts state is CatalogAliasState & { reviewStatus: CatalogAliasReviewStateKey } {
  assert(state.aliasHash !== null && state.reviewStatus !== null, "Catalog Alias must be proposed first.");
}

/**
 * Convenience re-export so callers building proposals from raw input do not need
 * to import both modules.
 */
export { buildCatalogAliasCandidate };
export type { CatalogAliasCandidate };
