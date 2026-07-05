import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import {
  withPgTransaction,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const projectionDbContext = new AsyncLocalStorage<PgQueryable>();

const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;
let nestedProjectionTransactionSequence = 0;

export function createProjectionAwarePool<TPool extends PgTransactionalPool>(pool: TPool): TPool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") {
        return <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          const scopedDb = projectionDbContext.getStore();
          return (scopedDb ?? target).query<Row>(text, values);
        };
      }
      if (property === "connect") {
        return async () => {
          const scopedDb = projectionDbContext.getStore();
          return scopedDb ? createNestedProjectionClient(scopedDb) : target.connect();
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
    const idleInTransactionSessionTimeoutMs = normalizeProjectionIdleInTransactionSessionTimeoutMs(
      context?.idleInTransactionSessionTimeoutMs,
    );
    if (
      idleInTransactionSessionTimeoutMs !== null &&
      pool.idleInTransactionSessionTimeoutMillis !== idleInTransactionSessionTimeoutMs
    ) {
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
        `${idleInTransactionSessionTimeoutMs}ms`,
      ]);
    }

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

function normalizeProjectionIdleInTransactionSessionTimeoutMs(
  idleInTransactionSessionTimeoutMs: number | undefined,
): number | null {
  if (
    idleInTransactionSessionTimeoutMs === undefined ||
    !Number.isFinite(idleInTransactionSessionTimeoutMs) ||
    idleInTransactionSessionTimeoutMs <= 0
  ) {
    return null;
  }

  return Math.ceil(idleInTransactionSessionTimeoutMs);
}

function normalizeProjectionStatementTimeoutMs(statementTimeoutMs: number | undefined): number | null {
  if (statementTimeoutMs === undefined || !Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return null;
  }

  return Math.min(Math.ceil(statementTimeoutMs), MAX_STATEMENT_TIMEOUT_MS);
}

function createNestedProjectionClient(scopedDb: PgQueryable): PgPoolClient {
  const savepoints: string[] = [];

  return {
    query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      const transactionCommand = normalizeTransactionCommand(text);
      if (transactionCommand === "BEGIN") {
        const savepoint = nextNestedProjectionTransactionSavepoint();
        savepoints.push(savepoint);
        await scopedDb.query(`SAVEPOINT ${savepoint}`);
        return { rows: [] as Row[], rowCount: 0 };
      }

      if (transactionCommand === "COMMIT" && savepoints.length > 0) {
        const savepoint = savepoints.pop()!;
        await scopedDb.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { rows: [] as Row[], rowCount: 0 };
      }

      if (transactionCommand === "ROLLBACK" && savepoints.length > 0) {
        const savepoint = savepoints.pop()!;
        await scopedDb.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await scopedDb.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { rows: [] as Row[], rowCount: 0 };
      }

      return scopedDb.query<Row>(text, values);
    },
    release: () => undefined,
  };
}

function normalizeTransactionCommand(text: string): "BEGIN" | "COMMIT" | "ROLLBACK" | null {
  const normalized = text.trim().replace(/;$/, "").toUpperCase();
  return normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ? normalized : null;
}

function nextNestedProjectionTransactionSavepoint(): string {
  nestedProjectionTransactionSequence += 1;
  return `projection_nested_tx_${nestedProjectionTransactionSequence}`;
}
