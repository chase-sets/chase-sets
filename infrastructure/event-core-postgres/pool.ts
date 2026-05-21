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

export function normalizePgPoolConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
      return url.toString();
    }
  } catch {
    return connectionString;
  }

  return connectionString;
}

export function createPgPool(connectionString: string, options: PgPoolOptions = {}): PgTransactionalPool {
  const normalizedConnectionString = normalizePgPoolConnectionString(connectionString);

  return new pg.Pool({
    connectionString: normalizedConnectionString,
    ssl: resolvePgPoolSslConfig(normalizedConnectionString),
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
