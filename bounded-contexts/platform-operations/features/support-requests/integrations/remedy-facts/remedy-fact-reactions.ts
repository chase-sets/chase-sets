import {
  normalizeProtectionCoverageRejectedV1,
  normalizeProtectionCoverageReservedV1,
  normalizeProtectionCoverageSettledV1,
} from "@chase-sets/event-core/platform-coverage-facts";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CoverageId, RemedyId } from "@chase-sets/primitives/typed-ids";
import type { SupportRequestServices } from "../../api/runtime";

type RemedyEffectWriter = Pick<SupportRequestServices, "recordRemedyEffect">;

function eventContext(event: {
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

/**
 * Settlement facts are translated into Support-owned remedy-effect facts. The foreign fact is never copied into
 * the Support stream as though Support published it; the local event records its identity, correlation, outcome,
 * and reason. The aggregate's idempotency key makes subscription replay and duplicate delivery harmless.
 */
export function buildSupportRemedyFactReactionHandlers(services: RemedyEffectWriter): ProjectorHandlerMap {
  return {
    "settlement.protection-coverage.reserved.v1": async (event) => {
      const fact = normalizeProtectionCoverageReservedV1(event.data as never);
      await services.recordRemedyEffect(
        {
          supportRequestId: fact.supportRequestId,
          remedyId: fact.remedyId as RemedyId,
          coverageId: fact.coverageId as CoverageId,
          effect: "coverage-reservation",
          outcome: "satisfied",
          sourceFactType: event.type,
          sourceFactId: event.id,
          idempotencyKey: fact.idempotencyKey,
          occurredAt: fact.occurredAt,
          reasonCode: "coverage-reserved",
          refundId: null,
          amount: fact.reservedAmount,
          currencyCode: fact.currencyCode,
          allocation: null,
        },
        eventContext(event),
      );
    },
    "settlement.protection-coverage.rejected.v1": async (event) => {
      const fact = normalizeProtectionCoverageRejectedV1(event.data as never);
      await services.recordRemedyEffect(
        {
          supportRequestId: fact.supportRequestId,
          remedyId: fact.remedyId as RemedyId,
          coverageId: fact.coverageId as CoverageId,
          effect: "coverage-reservation",
          outcome: "failed-terminal",
          sourceFactType: event.type,
          sourceFactId: event.id,
          idempotencyKey: fact.idempotencyKey,
          occurredAt: fact.occurredAt,
          reasonCode: fact.reasonCode,
          refundId: null,
          amount: fact.requestedAmount,
          currencyCode: fact.currencyCode,
          allocation: null,
        },
        eventContext(event),
      );
    },
    "settlement.protection-coverage.settled.v1": async (event) => {
      const fact = normalizeProtectionCoverageSettledV1(event.data as never);
      await services.recordRemedyEffect(
        {
          supportRequestId: fact.supportRequestId,
          remedyId: fact.remedyId as RemedyId,
          coverageId: fact.coverageId as CoverageId,
          effect: "settlement-reconciliation",
          outcome: "satisfied",
          sourceFactType: event.type,
          sourceFactId: event.id,
          idempotencyKey: fact.idempotencyKey,
          occurredAt: fact.occurredAt,
          reasonCode: "coverage-settled",
          refundId: fact.refundId,
          amount: fact.allocation.platformFundedAmount,
          currencyCode: fact.currencyCode,
          allocation: fact.allocation,
        },
        eventContext(event),
      );
    },
  };
}
