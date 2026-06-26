import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

const projectionDbContext = new AsyncLocalStorage<PgQueryable>();

const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export function createProjectionAwarePool<TPool extends PgTransactionalPool>(pool: TPool): TPool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") {
        return <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          const scopedDb = projectionDbContext.getStore();
          return (scopedDb ?? target).query<Row>(text, values);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TPool;
}

export function runInProjectionDbContext<T>(db: PgQueryable, work: () => T): T {
  return projectionDbContext.run(db, work);
}

export async function withProjectionTransaction<T>(
  pool: PgTransactionalPool,
  context: ProjectionRunContext | undefined,
  work: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  context?.throwIfLeaseLost?.();
  return withPgTransaction(pool, async (client) => {
    const statementTimeoutMs = normalizeProjectionStatementTimeoutMs(context?.statementTimeoutMs);
    if (statementTimeoutMs !== null) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
    }

    context?.throwIfLeaseLost?.();
    const result = await work(client);
    context?.throwIfLeaseLost?.();
    return result;
  });
}

function normalizeProjectionStatementTimeoutMs(statementTimeoutMs: number | undefined): number | null {
  if (statementTimeoutMs === undefined || !Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return null;
  }

  return Math.min(Math.ceil(statementTimeoutMs), MAX_STATEMENT_TIMEOUT_MS);
}
