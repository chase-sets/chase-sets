import pg from "pg";
import type { PgTransactionalPool } from "./types";

export type PgPoolOptions = Readonly<{
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}>;

export function resolvePgPoolSslConfig(
  connectionString: string,
): boolean | { rejectUnauthorized: boolean } | undefined {
  const sslMode = readConnectionStringParam(connectionString, "sslmode");

  if (sslMode === "require") {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

export function createPgPool(
  connectionString: string,
  options: PgPoolOptions = {},
): PgTransactionalPool {
  return new pg.Pool({
    connectionString,
    ssl: resolvePgPoolSslConfig(connectionString),
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  }) as unknown as PgTransactionalPool;
}

function readConnectionStringParam(connectionString: string, param: string) {
  try {
    return new URL(connectionString).searchParams.get(param);
  } catch {
    return null;
  }
}
