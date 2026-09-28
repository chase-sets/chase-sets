import { isDeepStrictEqual } from "node:util";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { ListingAuthoritySource } from "@chase-sets/platform-runtime/listing-authority-participant";
import type { PricingEvaluationBudget } from "./listing-authority";
import { pricingAuthorityDigest } from "./listing-authority-resources";

export type PricingSqlAuthorityCommand = Readonly<{
  kind: string;
  body: JsonObject;
  context: EventStoreContext;
}>;
export type PricingSqlAuthorityHandler = Readonly<{
  resources(body: JsonObject): Promise<readonly string[]>;
  apply(db: PgQueryable, body: JsonObject): Promise<JsonValue>;
}>;

export class PricingSqlMutationPendingError extends Error {
  constructor(
    public readonly mutationId: string,
    options: ErrorOptions,
  ) {
    super("Pricing SQL mutation is unresolved; resume the same durable mutation.", options);
    this.name = "PricingSqlMutationPendingError";
  }
}

/** The receipt and SQL effect share one local transaction. No remote call holds a database lock. */
export function createPricingAuthoritySqlWriter(
  deps: Readonly<{
    pool: PgTransactionalPool;
    source: ListingAuthoritySource;
    handlers: Readonly<Record<string, PricingSqlAuthorityHandler>>;
  }>,
) {
  async function receipt(mutationId: string, command: PricingSqlAuthorityCommand) {
    const result = await deps.pool.query<{ command: PricingSqlAuthorityCommand; result: JsonValue }>(
      "SELECT command, result FROM pricing_authority_sql_mutations WHERE mutation_id = $1",
      [mutationId],
    );
    const row = result.rows[0];
    if (row && !isDeepStrictEqual(row.command, command)) throw new Error("Pricing SQL mutation identity conflict.");
    return row ?? null;
  }
  async function execute(mutationId: string, command: PricingSqlAuthorityCommand, resources: readonly string[]) {
    const handler = deps.handlers[command.kind];
    if (!handler) throw new Error("Unregistered Pricing SQL authority writer.");
    try {
      await deps.source.mutate({
        mutationId,
        resources,
        command: command as unknown as JsonObject,
        context: command.context,
        prepare: async () => {
          await withPgTransaction(deps.pool, async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
              `pricing-authority-sql:${mutationId}`,
            ]);
            const prior = await client.query<{ command: PricingSqlAuthorityCommand; result: JsonValue }>(
              "SELECT command, result FROM pricing_authority_sql_mutations WHERE mutation_id = $1",
              [mutationId],
            );
            if (prior.rows[0]) {
              if (!isDeepStrictEqual(prior.rows[0].command, command))
                throw new Error("Pricing SQL mutation identity conflict.");
              return;
            }
            const current = [...new Set(await handler.resources(command.body))].sort();
            if (!isDeepStrictEqual(current, [...resources].sort()))
              throw new Error("Pricing SQL mutation predicate changed; retain closure for reconciliation.");
            const result = await handler.apply(client, command.body);
            await client.query(
              `INSERT INTO pricing_authority_sql_mutations (mutation_id, command, result)
               VALUES ($1, $2::jsonb, $3::jsonb)`,
              [mutationId, JSON.stringify(command), JSON.stringify(result)],
            );
          });
          return [];
        },
      });
      const result = await receipt(mutationId, command);
      if (!result) throw new Error("Completed Pricing SQL mutation lost its authoritative receipt.");
      return result.result;
    } catch (cause) {
      throw new PricingSqlMutationPendingError(mutationId, { cause });
    }
  }
  const api = {
    async run(mutationId: string, command: PricingSqlAuthorityCommand) {
      // Compare the durable JSON wire shape, not optional undefined properties erased by PostgreSQL.
      command = JSON.parse(JSON.stringify(command)) as PricingSqlAuthorityCommand;
      const retained = await deps.source.inspectInvalidation(command.context.tenantId, mutationId);
      if (retained) {
        if (!isDeepStrictEqual(retained.intent.command, command))
          throw new Error("Pricing SQL mutation identity conflict.");
        return execute(mutationId, command, retained.intent.resources);
      }
      const handler = deps.handlers[command.kind];
      if (!handler) throw new Error("Unregistered Pricing SQL authority writer.");
      return execute(mutationId, command, [...new Set(await handler.resources(command.body))].sort());
    },
    async resume(mutationId: string, context: EventStoreContext) {
      const retained = await deps.source.inspectInvalidation(context.tenantId, mutationId);
      if (!retained) throw new Error("Unknown Pricing SQL mutation.");
      const command = retained.intent.command as unknown as PricingSqlAuthorityCommand;
      if (pricingAuthorityDigest(command.context) !== pricingAuthorityDigest(context))
        throw new Error("Pricing SQL recovery context changed.");
      return execute(mutationId, command, retained.intent.resources);
    },
  };
  return {
    ...api,
    async recover(input: Readonly<{ after?: string; limit?: number }> = {}) {
      const after = input.after ?? "0";
      const limit = input.limit ?? 25;
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid Pricing SQL recovery page.");
      const page = await deps.pool.query<{ global_position: string; tenant_id: string; payload: JsonObject }>(
        `SELECT global_position::text, tenant_id, payload FROM event_store_events pending
         WHERE event_type = 'pricing.listing-authority.invalidation-started' AND global_position > $1::bigint
           AND payload->'intent'->'command'->>'kind' = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM event_store_events terminal WHERE terminal.stream_id = pending.stream_id
             AND terminal.event_type = 'pricing.listing-authority.invalidation-completed')
         ORDER BY global_position LIMIT $3`,
        [after, Object.keys(deps.handlers), limit],
      );
      if (page.rows.length > limit) throw new Error("Pricing SQL recovery exceeded its bound.");
      const outcomes: { mutationId: string; status: "resumed" | "pending"; error: string | null }[] = [];
      for (const row of page.rows) {
        const intent = row.payload.intent as unknown as { mutationId: string; command: PricingSqlAuthorityCommand };
        try {
          if (!intent?.mutationId || intent.command?.context?.tenantId !== row.tenant_id)
            throw new Error("Pricing SQL discovery record is incomplete.");
          await api.resume(intent.mutationId, intent.command.context);
          outcomes.push({ mutationId: intent.mutationId, status: "resumed", error: null });
        } catch (error) {
          outcomes.push({
            mutationId: intent?.mutationId ?? "unknown",
            status: "pending",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { after: page.rows.at(-1)?.global_position ?? after, outcomes };
    },
  };
}

/** One ticket consumes the same counter used by the existing live worker, never a second budget. */
export function createPricingEvaluationBudget(pool: PgTransactionalPool): PricingEvaluationBudget {
  const inspect: PricingEvaluationBudget["inspect"] = async (evaluationId) => {
    const result = await pool.query<{ accountId: string; day: string; status: "reserved" | "released" }>(
      `SELECT seller_account_id AS "accountId", budget_day::text AS day, status
       FROM pricing_evaluation_budget_admissions WHERE evaluation_id = $1`,
      [evaluationId],
    );
    return result.rows[0] ?? null;
  };
  return {
    inspect,
    reserve: async (input) =>
      withPgTransaction(pool, async (client) => {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(input.day))
          throw new Error("Invalid Pricing budget admission.");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `pricing-evaluation:${input.evaluationId}`,
        ]);
        const retained = await client.query<{ binding: string; status: string }>(
          "SELECT binding, status FROM pricing_evaluation_budget_admissions WHERE evaluation_id = $1",
          [input.evaluationId],
        );
        const binding = pricingAuthorityDigest(input);
        if (retained.rows[0]) {
          if (retained.rows[0].binding !== binding) throw new Error("Pricing budget admission identity conflict.");
          return retained.rows[0].status === "reserved";
        }
        await client.query(
          `INSERT INTO pricing_repricing_daily_change_budgets (seller_account_id, budget_day, changes_reserved, updated_at)
         VALUES ($1, $2, 0, now()) ON CONFLICT (seller_account_id, budget_day) DO NOTHING`,
          [input.accountId, input.day],
        );
        const admitted = await client.query(
          `UPDATE pricing_repricing_daily_change_budgets SET changes_reserved = changes_reserved + 1, updated_at = now()
         WHERE seller_account_id = $1 AND budget_day = $2 AND changes_reserved < $3 RETURNING seller_account_id`,
          [input.accountId, input.day, input.limit],
        );
        if (!admitted.rows.length) return false;
        await client.query(
          `INSERT INTO pricing_evaluation_budget_admissions (evaluation_id, seller_account_id, budget_day, binding, status)
         VALUES ($1, $2, $3, $4, 'reserved')`,
          [input.evaluationId, input.accountId, input.day, binding],
        );
        return true;
      }),
    release: async (evaluationId) =>
      withPgTransaction(pool, async (client) => {
        const released = await client.query<{ seller_account_id: string; budget_day: string }>(
          `UPDATE pricing_evaluation_budget_admissions SET status = 'released'
         WHERE evaluation_id = $1 AND status = 'reserved' RETURNING seller_account_id, budget_day::text`,
          [evaluationId],
        );
        if (!released.rows[0]) return;
        await client.query(
          `UPDATE pricing_repricing_daily_change_budgets SET changes_reserved = changes_reserved - 1, updated_at = now()
         WHERE seller_account_id = $1 AND budget_day = $2 AND changes_reserved > 0`,
          [released.rows[0].seller_account_id, released.rows[0].budget_day],
        );
      }),
  };
}
