import pg from "pg";
import type { PgTransactionalPool } from "./types";

export type PgPoolOptions = Readonly<{
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}>;

export function createPgPool(
  connectionString: string,
  options: PgPoolOptions = {},
): PgTransactionalPool {
  return new pg.Pool({
    connectionString,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  }) as unknown as PgTransactionalPool;
}
