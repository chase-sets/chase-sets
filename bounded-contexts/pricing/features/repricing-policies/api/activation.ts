import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { withPgTransaction, type PgTransactionalPool, type PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import {
  hashRepricingDryRunBody,
  validateRepricingDryRunBody,
  type RepricingDryRunBody,
} from "../../repricing-engine/api/dry-run";
import {
  decideRepricingPolicy,
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  type RepricingPolicyEvent,
} from "../domain/domain";
import { repricingPolicyStreamId } from "../read-model/projection";

export class DryRunRequiredError extends Error {
  constructor() {
    super("dry_run_required");
  }
}

export function createRepricingPolicyActivationServices(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction">;
  }>,
) {
  const codec = createPassthroughDomainEventCodec<RepricingPolicyEvent>();
  return {
    activateRepricingPolicy: async (
      input: Readonly<{ accountId: string; dryRunId: string; name: string }>,
      context: EventStoreContext,
    ) =>
      withPgTransaction(deps.pool, async (client) => {
        const run = (
          await client.query<{
            body: RepricingDryRunBody;
            body_hash: string;
            status: string;
            consumed_at: string | null;
            job_status: string;
          }>(
            `SELECT run.body, run.body_hash, run.status, run.consumed_at, job.status AS job_status
           FROM pricing_repricing_dry_runs AS run
           JOIN pricing_repricing_dry_run_jobs AS job ON job.job_id = run.dry_run_id
             AND job.payload->>'sellerAccountId' = run.seller_account_id
           WHERE run.seller_account_id = $1 AND run.dry_run_id = $2`,
            [input.accountId, input.dryRunId],
          )
        ).rows[0];
        if (!run) return null;
        if (
          run.status !== "completed" ||
          run.job_status === "failed" ||
          run.job_status === "cancelled" ||
          run.consumed_at !== null
        )
          throw new DryRunRequiredError();
        try {
          if (
            hashRepricingDryRunBody(run.body) !== run.body_hash ||
            hashRepricingDryRunBody(validateRepricingDryRunBody(run.body, input.accountId)) !== run.body_hash
          )
            throw new DryRunRequiredError();
        } catch {
          throw new DryRunRequiredError();
        }
        const policyId = createId("rpp");
        const createdAt = new Date().toISOString();
        const events = decideRepricingPolicy(initialRepricingPolicyState, {
          ...run.body,
          type: "CreateRepricingPolicy",
          policyId,
          accountId: parseTypedId(input.accountId, "acc"),
          name: input.name,
          createdAt,
        });
        const consumed = await client.query(
          `UPDATE pricing_repricing_dry_runs AS run SET consumed_at = $3, updated_at = $3
           WHERE seller_account_id = $1 AND dry_run_id = $2 AND consumed_at IS NULL
             AND status = 'completed' AND body_hash = $4 AND body = $5::jsonb
             AND EXISTS (SELECT 1 FROM pricing_repricing_dry_run_jobs AS job
               WHERE job.job_id = run.dry_run_id AND job.status NOT IN ('failed', 'cancelled')
                 AND job.payload->>'sellerAccountId' = run.seller_account_id)
           RETURNING dry_run_id`,
          [input.accountId, input.dryRunId, createdAt, run.body_hash, JSON.stringify(run.body)],
        );
        if (!consumed.rows.length) throw new DryRunRequiredError();
        await deps.eventStore.appendToStreamInTransaction(client, {
          streamId: repricingPolicyStreamId(policyId),
          expectedVersion: "no_stream",
          context,
          wakeSourceContextName: "pricing",
          events: events.map(codec.encode),
        });
        return events.reduce(evolveRepricingPolicy, initialRepricingPolicyState);
      }),
  };
}

export type RepricingPolicyActivationServices = ReturnType<typeof createRepricingPolicyActivationServices>;
