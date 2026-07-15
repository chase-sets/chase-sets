import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { normalizeSupportRequestPlatformCoverageRequestedV1 } from "@chase-sets/event-core/platform-coverage-facts";
import type { ProtectionCoverageSettlementPort } from "../../api/ports";

/**
 * Reserve integration — Settlement's response to Support asking it to reserve the
 * platform-funded portion of a remedy (ADR 0022 event flow). Support publishes
 * `support.support-request.platform-coverage-requested.v1`; Settlement, which owns
 * financial truth and the protection reserve, decides whether the amount can be
 * reserved against available funds and appends the reservation to the ProtectionCoverage
 * aggregate. The aggregate is the authority; this projection is only the seam that turns
 * the cross-context request into the reserve command, keyed idempotently by coverage id.
 *
 * A rejection (insufficient reserve, policy limit, currency mismatch, conflicting terms)
 * is not an error here — the aggregate records a `rejected` fact with a closed reason and
 * the case stays open and operator-actionable. Only an infrastructure failure throws so
 * the projection retries.
 */
export function buildSettlementCoverageReservationHandlers(
  protectionCoverage: ProtectionCoverageSettlementPort,
): ProjectorHandlerMap {
  return {
    "support.support-request.platform-coverage-requested.v1": async (event) => {
      const fact = normalizeSupportRequestPlatformCoverageRequestedV1(
        event.data as Parameters<typeof normalizeSupportRequestPlatformCoverageRequestedV1>[0],
      );

      await protectionCoverage.reserve(
        {
          coverageId: fact.coverageId,
          remedyId: fact.remedyId,
          supportRequestId: fact.supportRequestId,
          requestedAmount: fact.requestedAmount,
          currencyCode: fact.currencyCode,
          policyVersion: fact.policyVersion,
          reasonCode: fact.reasonCode,
          causationId: fact.causationId,
          idempotencyKey: fact.idempotencyKey,
          occurredAt: fact.occurredAt,
        },
        { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      );
    },
  };
}
