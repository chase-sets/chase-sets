export type PgQueryResult<Row> = Readonly<{
  rows: Row[];
  rowCount?: number | null;
}>;

export interface PgQueryFunction {
  <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  (text: string, values?: readonly unknown[]): Promise<PgQueryResult<Record<string, unknown>>>;
}

export type PgQueryable = Readonly<{
  query: PgQueryFunction;
}>;

export type PgPoolClient = PgQueryable &
  Readonly<{
    release: (error?: unknown) => void;
  }>;

export type PgTransactionalPool = PgQueryable &
  Readonly<{
    connect: () => Promise<PgPoolClient>;
    idleInTransactionSessionTimeoutMillis?: number;
  }>;

export const POSTGRES_RETRYABLE_TRANSIENT_CODES = new Set(["40001", "40P01", "55P03", "57014"]);

export async function withPgTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
  options: Readonly<{
    afterCommit?: (client: PgPoolClient, result: T) => Promise<void>;
  }> = {},
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  let releaseError: unknown;

  try {
    await client.query("BEGIN");
    if (isPositiveFiniteNumber(pool.idleInTransactionSessionTimeoutMillis)) {
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
        `${Math.ceil(pool.idleInTransactionSessionTimeoutMillis)}ms`,
      ]);
    }
    const result = await work(client);
    await client.query("COMMIT");
    committed = true;
    await options.afterCommit?.(client, result);
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    if (releaseError === undefined && isPgConnectionLevelError(error)) {
      releaseError = error;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isPgConnectionLevelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{
    code?: unknown;
    message?: unknown;
  }>;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "08000" ||
    code === "08001" ||
    code === "08003" ||
    code === "08004" ||
    code === "08006" ||
    code === "08007" ||
    code === "08P01" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03"
  ) {
    return true;
  }

  if (typeof candidate.message !== "string") {
    return false;
  }

  const message = candidate.message.toLowerCase();
  return (
    message.includes("connection terminated") ||
    message.includes("connection ended unexpectedly") ||
    message.includes("client has encountered a connection error") ||
    message.includes("connection is not queryable") ||
    message.includes("terminating connection")
  );
}

export function isPgRetryableTransientError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{ code?: unknown }>;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  return POSTGRES_RETRYABLE_TRANSIENT_CODES.has(code) || isPgConnectionLevelError(error);
}
