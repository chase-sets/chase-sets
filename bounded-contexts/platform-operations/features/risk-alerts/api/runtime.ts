import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { RiskAlertAction } from "./contracts";
import { buildRiskAlertProjectionHandlers } from "../read-model/projection";
import { getRiskAlertQueueItem, getRiskAlertQueueMetrics, listRiskAlertQueue } from "../read-model/queries";
import type { PayoutReviewHoldCrossContextPort } from "./cross-context";

export type RiskAlertServices = Readonly<{
  listRiskAlertQueue: (params: Parameters<typeof listRiskAlertQueue>[1]) => ReturnType<typeof listRiskAlertQueue>;
  getRiskAlertQueueItem: (alertId: string) => ReturnType<typeof getRiskAlertQueueItem>;
  getRiskAlertQueueMetrics: () => ReturnType<typeof getRiskAlertQueueMetrics>;
  recordRiskAlertAction: (
    params: Readonly<{ alertId: string; action: RiskAlertAction; note: string | null; operatorUserId: string | null; actorPermissions?: readonly string[] }>,
    context: EventStoreContext,
  ) => Promise<{ actionId: string; recordedAt: string }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createRiskAlertRuntime(
  deps: Readonly<{
    db: PgQueryable;
    eventStore: EventStore;
    payoutReviewHoldCrossContext?: PayoutReviewHoldCrossContextPort;
  }>,
): RiskAlertServices {
  return {
    listRiskAlertQueue: (params) => listRiskAlertQueue(deps.db, params),
    getRiskAlertQueueItem: (alertId) => getRiskAlertQueueItem(deps.db, alertId),
    getRiskAlertQueueMetrics: () => getRiskAlertQueueMetrics(deps.db),
    recordRiskAlertAction: async (params, context) => {
      const alert = await getRiskAlertQueueItem(deps.db, params.alertId);
      if (!alert) throw new Error("Risk alert was not found.");
      if (params.action === "request-manual-payout-review") {
        if (!deps.payoutReviewHoldCrossContext) throw new Error("Settlement payout review hold is not mounted.");
        const reason = params.note?.trim() || `Risk alert ${params.alertId}`;
        if (reason.length > 500) throw new Error("Risk alert note must be 500 characters or fewer.");
        await deps.payoutReviewHoldCrossContext.placeRiskAlertHold(
          { accountId: alert.account_id, reason, sourceReference: params.alertId, actorPermissions: params.actorPermissions ?? [] },
          context,
        );
      }
      const actionId = createId("raa");
      const recordedAt = new Date().toISOString();
      await deps.eventStore.appendToStream({
        streamId: `platform-operations.risk-alert-${params.alertId}` as never,
        expectedVersion: "any",
        events: [
          {
            eventType: "platform-operations.risk-alert.action-recorded",
            payload: {
              actionId,
              alertId: params.alertId,
              action: params.action,
              note: params.note,
              operatorUserId: params.operatorUserId,
              recordedAt,
            },
          },
        ],
        context,
      });
      return { actionId, recordedAt };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "platform-operations-risk-alert-action-projection",
        handlers: buildRiskAlertProjectionHandlers(deps.db),
        streamPrefixes: ["platform-operations.risk-alert-"],
      }),
    ],
  };
}
