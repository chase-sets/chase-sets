import { readFileSync } from "node:fs";
import pg from "pg";
import type { PgTransactionalPool } from "./types";

export type PgPoolOptions = Readonly<{
  max?: number;
  idleTimeoutMillis?: number;
  idleInTransactionSessionTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  onIdleClientError?: (event: PgPoolIdleClientErrorEvent) => void;
  onActiveClientError?: (event: PgPoolActiveClientErrorEvent) => void;
}>;

export type PgPoolIdleClientErrorEvent = Readonly<{
  error: unknown;
}>;

export type PgPoolActiveClientErrorEvent = Readonly<{
  error: unknown;
}>;

export type PgPoolSslConfig = boolean | { rejectUnauthorized: boolean; ca?: string };
type PgPoolSslEnv = Readonly<{ PGSSLROOTCERT?: string }>;

export function resolvePgPoolSslConfig(
  connectionString: string,
  env: PgPoolSslEnv = process.env,
): PgPoolSslConfig | undefined {
  const parsed = parseConnectionString(connectionString);

  if (!parsed) {
    return undefined;
  }

  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();

  if (sslMode === "disable") {
    return undefined;
  }

  if (sslMode === "require") {
    return { rejectUnauthorized: false };
  }

  if (sslMode === "verify-ca" || sslMode === "verify-full") {
    return verifyingSslConfig(parsed, env);
  }

  if (!isLocalDatabaseHost(parsed.hostname)) {
    return verifyingSslConfig(parsed, env);
  }

  return undefined;
}

export function normalizePgPoolConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode && sslMode !== "disable" && !url.searchParams.has("uselibpqcompat")) {
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

  const pool = new pg.Pool({
    connectionString: normalizedConnectionString,
    ssl: resolvePgPoolSslConfig(normalizedConnectionString),
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  });

  pool.on("error", (error: unknown) => {
    try {
      options.onIdleClientError?.({ error });
    } catch {
      // Pool idle-client errors must never crash the process.
    }
  });

  pool.on("connect", (client: PgActiveClient) => {
    client.on("error", (error: unknown) => {
      try {
        options.onActiveClientError?.({ error });
      } catch {
        // Active checked-out client errors must never crash the process.
      }
    });
  });

  return pool as unknown as PgTransactionalPool;
}

type PgActiveClient = pg.PoolClient & {
  on: (event: "error", listener: (error: unknown) => void) => void;
};

function verifyingSslConfig(connectionString: URL, env: PgPoolSslEnv): Extract<PgPoolSslConfig, object> {
  const caPath = connectionString.searchParams.get("sslrootcert") ?? env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, "utf8") : undefined;

  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function isLocalDatabaseHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseConnectionString(connectionString: string): URL | null {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}
