import { AsyncLocalStorage } from "node:async_hooks";
import {
  createProjectionTransactionBudgetExceededError,
  type ProjectionRunContext,
} from "@chase-sets/event-core/projector";
import { recordEventStoreAppendAdvisoryLockHold } from "@chase-sets/observability";
import {
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  isPgConnectionLevelError,
  type PgPoolClient,
  type PgQueryFunction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const projectionDbContext = new AsyncLocalStorage<PgQueryable>();

const DEFAULT_PROJECTION_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 15_000;
const DEFAULT_PROJECTION_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;
let nestedProjectionTransactionSequence = 0;

export type ProjectionTransactionTelemetry = Readonly<{
  handlerKind?: string;
  targetContextName?: string;
  sourceContextName?: string;
  projectionName?: string;
  subscriptionName?: string;
}>;

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
  telemetry: ProjectionTransactionTelemetry = {},
): Promise<T> {
  context?.throwIfLeaseLost?.();
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const mutableClient = client as PgPoolClient & { query: PgQueryFunction };
  let committed = false;
  let releaseError: unknown;
  let appendAdvisoryLockAcquiredAtMs: number | null = null;
  let appendAdvisoryLockRecorded = false;
  const recordAppendAdvisoryLockHold = (outcome: "committed" | "rolled_back" | "released") => {
    if (appendAdvisoryLockAcquiredAtMs === null || appendAdvisoryLockRecorded) {
      return;
    }

    appendAdvisoryLockRecorded = true;
    recordEventStoreAppendAdvisoryLockHold({
      durationMs: Date.now() - appendAdvisoryLockAcquiredAtMs,
      outcome,
      holderKind: telemetry.handlerKind,
      targetContextName: telemetry.targetContextName,
      sourceContextName: telemetry.sourceContextName,
      projectionName: telemetry.projectionName,
      subscriptionName: telemetry.subscriptionName,
    });
  };

  try {
    await originalQuery("BEGIN");
    const timeoutGuard = createProjectionTransactionTimeoutGuard({
      startedAtMs: Date.now(),
      transactionTimeoutMs: normalizeProjectionTransactionTimeoutMs(context?.transactionTimeoutMs),
      throwIfLeaseLost: context?.throwIfLeaseLost,
    });
    mutableClient.query = async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      timeoutGuard();
      const result = await originalQuery<Row>(text, values);
      if (appendAdvisoryLockAcquiredAtMs === null && isGlobalAppendAdvisoryLockQuery(text, values)) {
        appendAdvisoryLockAcquiredAtMs = Date.now();
      }
      timeoutGuard();
      return result;
    };

    const idleInTransactionSessionTimeoutMs = normalizeProjectionIdleInTransactionSessionTimeoutMs(
      context?.idleInTransactionSessionTimeoutMs,
      pool.idleInTransactionSessionTimeoutMillis,
    );
    if (idleInTransactionSessionTimeoutMs !== null) {
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
        `${idleInTransactionSessionTimeoutMs}ms`,
      ]);
    }

    const statementTimeoutMs = normalizeProjectionStatementTimeoutMs(
      context?.statementTimeoutMs,
      timeoutGuard.transactionTimeoutMs,
    );
    if (statementTimeoutMs !== null) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
    }

    context?.throwIfLeaseLost?.();
    const result = await work(client);
    context?.throwIfLeaseLost?.();
    timeoutGuard();
    mutableClient.query = originalQuery;
    await originalQuery("COMMIT");
    committed = true;
    recordAppendAdvisoryLockHold("committed");
    return result;
  } catch (error) {
    mutableClient.query = originalQuery;
    if (!committed) {
      try {
        await originalQuery("ROLLBACK");
        recordAppendAdvisoryLockHold("rolled_back");
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    if (releaseError === undefined && isPgConnectionLevelError(error)) {
      releaseError = error;
    }
    throw error;
  } finally {
    mutableClient.query = originalQuery;
    recordAppendAdvisoryLockHold("released");
    client.release(releaseError);
  }
}

function normalizeProjectionIdleInTransactionSessionTimeoutMs(
  idleInTransactionSessionTimeoutMs: number | undefined,
  poolIdleInTransactionSessionTimeoutMs: number | undefined,
): number | null {
  return normalizePositiveIntegerMs(
    idleInTransactionSessionTimeoutMs ??
      poolIdleInTransactionSessionTimeoutMs ??
      DEFAULT_PROJECTION_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  );
}

function normalizeProjectionTransactionTimeoutMs(transactionTimeoutMs: number | undefined): number | null {
  return normalizePositiveIntegerMs(transactionTimeoutMs ?? DEFAULT_PROJECTION_TRANSACTION_TIMEOUT_MS);
}

function normalizeProjectionStatementTimeoutMs(
  statementTimeoutMs: number | undefined,
  transactionTimeoutMs: number | null,
): number | null {
  const normalizedStatementTimeoutMs = normalizePositiveIntegerMs(statementTimeoutMs);
  if (normalizedStatementTimeoutMs === null) {
    return transactionTimeoutMs;
  }
  if (transactionTimeoutMs === null) {
    return normalizedStatementTimeoutMs;
  }

  return Math.min(normalizedStatementTimeoutMs, transactionTimeoutMs);
}

function normalizePositiveIntegerMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(Math.ceil(value), MAX_STATEMENT_TIMEOUT_MS);
}

function isGlobalAppendAdvisoryLockQuery(text: string, values: readonly unknown[] | undefined): boolean {
  return (
    text.includes("pg_advisory_xact_lock") &&
    (values ?? []).some((value) => String(value) === EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY)
  );
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

function createProjectionTransactionTimeoutGuard(
  options: Readonly<{
    startedAtMs: number;
    transactionTimeoutMs: number | null;
    throwIfLeaseLost?: () => void;
  }>,
): (() => void) & Readonly<{ transactionTimeoutMs: number | null }> {
  const guard = () => throwIfProjectionTransactionExpired(options);
  return Object.assign(guard, { transactionTimeoutMs: options.transactionTimeoutMs });
}

function throwIfProjectionTransactionExpired(
  options: Readonly<{
    startedAtMs: number;
    transactionTimeoutMs: number | null;
    throwIfLeaseLost?: () => void;
  }>,
): void {
  options.throwIfLeaseLost?.();
  if (options.transactionTimeoutMs === null) {
    return;
  }

  const elapsedMs = Date.now() - options.startedAtMs;
  if (elapsedMs > options.transactionTimeoutMs) {
    throw createProjectionTransactionBudgetExceededError(
      `Projection transaction exceeded ${options.transactionTimeoutMs}ms.`,
    );
  }
}

function normalizeTransactionCommand(text: string): "BEGIN" | "COMMIT" | "ROLLBACK" | null {
  const normalized = text.trim().replace(/;$/, "").toUpperCase();
  return normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ? normalized : null;
}

function nextNestedProjectionTransactionSavepoint(): string {
  nestedProjectionTransactionSequence += 1;
  return `projection_nested_tx_${nestedProjectionTransactionSequence}`;
}
