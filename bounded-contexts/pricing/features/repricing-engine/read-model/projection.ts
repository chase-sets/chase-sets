import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { repricingPolicyEvaluatedEventType, type RepricingPolicyEvaluatedEvent } from "../domain/fact";
import { projectListingOutcomeFacts } from "./listing-outcomes";

export function buildRepricingEvaluationProjectionHandlers(pool: PgTransactionalPool): ProjectorHandlerMap {
  return {
    [repricingPolicyEvaluatedEventType]: async (event, context) => {
      const data = event.data as RepricingPolicyEvaluatedEvent["data"];
      const project = async (db: PgQueryable) => {
        await db.query(
          `INSERT INTO pricing_repricing_policy_evaluations (
           evaluation_id, policy_id, policy_revision, seller_account_id,
           catalog_catalog_item_id, product_id,
           trigger_kind, trigger_event_id, trigger_signal_version,
           listings_evaluated, listings_changed, listings_skipped,
           listing_traces, signal_to_evaluation_latency_ms, evaluated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
         ON CONFLICT (evaluation_id) DO NOTHING`,
          [
            data.evaluationId,
            data.policyId,
            data.policyRevision,
            data.sellerAccountId,
            data.catalogItemId,
            data.productId,
            data.trigger.kind,
            data.trigger.eventId,
            data.trigger.signalVersion,
            data.listingsEvaluated,
            data.listingsChanged,
            data.listingsSkipped,
            JSON.stringify(data.listings),
            data.signalToEvaluationLatencyMs,
            data.evaluatedAt,
          ],
        );
        await projectListingOutcomeFacts(db, data, event.globalPosition);
      };
      if (context?.db) {
        await project(context.db as PgQueryable);
      } else {
        await withPgTransaction(pool, project);
      }
    },
  };
}
