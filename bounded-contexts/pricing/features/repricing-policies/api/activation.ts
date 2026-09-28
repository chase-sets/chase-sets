import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
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
import type { ListingAuthoritySource } from "@chase-sets/platform-runtime/listing-authority-participant";
import { toJsonValue } from "@chase-sets/primitives/json";
import { createPricingAuthoritySqlWriter } from "../../repricing-engine/api/listing-authority-sql";
import {
  pricingAuthorityDigest,
  pricingAuthorityResources,
} from "../../repricing-engine/api/listing-authority-resources";

export class DryRunRequiredError extends Error {
  constructor() {
    super("dry_run_required");
  }
}

export function createRepricingPolicyActivationServices(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction">;
    authority?: ListingAuthoritySource;
  }>,
) {
  const codec = createPassthroughDomainEventCodec<RepricingPolicyEvent>();
  const readReadyRun = async (
    client: PgQueryable,
    input: Readonly<{ accountId: string; dryRunId: string; name: string }>,
  ) => {
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
    return run;
  };
  const apply = async (client: PgPoolClient, input: Parameters<typeof readReadyRun>[1], context: EventStoreContext) => {
    const run = await readReadyRun(client, input);
    if (!run) return null;
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
    const storedEvents = await deps.eventStore.appendToStreamInTransaction(client, {
      streamId: repricingPolicyStreamId(policyId),
      expectedVersion: "no_stream",
      context,
      wakeSourceContextName: "pricing",
      events: events.map(codec.encode),
    });
    return { state: events.reduce(evolveRepricingPolicy, initialRepricingPolicyState), storedEvents };
  };
  const writer = deps.authority
    ? createPricingAuthoritySqlWriter({
        pool: deps.pool,
        source: deps.authority,
        handlers: {
          "activate-repricing-policy": {
            resources: async (body) => {
              const input = body.input as { accountId: string };
              return [pricingAuthorityResources.account(input.accountId)];
            },
            apply: async (client, body) => {
              try {
                return toJsonValue(
                  await apply(
                    client as PgPoolClient,
                    body.input as unknown as Parameters<typeof apply>[1],
                    body.context as unknown as EventStoreContext,
                  ),
                );
              } catch (error) {
                if (error instanceof DryRunRequiredError) return { rejection: "dry_run_required" };
                throw error;
              }
            },
          },
        },
      })
    : null;
  return {
    recoverAuthorityMutations: async (input: Readonly<{ after?: string; limit?: number }> = {}) => {
      if (!writer) throw new Error("Pricing activation authority is not mounted.");
      return writer.recover(input);
    },
    resumeAuthorityMutation: async (mutationId: string, context: EventStoreContext) => {
      if (!writer) throw new Error("Pricing activation authority is not mounted.");
      return writer.resume(mutationId, context);
    },
    activateRepricingPolicy: async (input: Parameters<typeof apply>[1], context: EventStoreContext) => {
      if (input.accountId !== context.audit.forAccountId) throw new Error("Pricing activation account mismatch.");
      const mutationId = `activation-${pricingAuthorityDigest([input.accountId, input.dryRunId])}`;
      if (writer && !(await deps.authority!.inspectInvalidation(context.tenantId, mutationId))) {
        // Readiness is only an early rejection, never authorization: apply rechecks inside the transaction.
        // A queued run must remain usable when it completes; an unknown prior attempt must instead resume.
        if (!(await readReadyRun(deps.pool, input))) return null;
      }
      const result = writer
        ? ((await writer.run(mutationId, {
            kind: "activate-repricing-policy",
            body: { input: toJsonValue(input), context: toJsonValue(context) },
            context,
          })) as Awaited<ReturnType<typeof apply>> | { rejection: "dry_run_required" })
        : await withPgTransaction(deps.pool, (client) => apply(client, input, context));
      if (!result) return null;
      if ("rejection" in result) throw new DryRunRequiredError();
      recordCommittedEvents(result.storedEvents, "pricing");
      return result.state;
    },
  };
}

export type RepricingPolicyActivationServices = ReturnType<typeof createRepricingPolicyActivationServices>;
