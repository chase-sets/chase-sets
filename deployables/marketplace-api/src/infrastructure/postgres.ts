import pg from "pg";
import type { PgTransactionalPool } from "../../../../contracts/event-core/postgres/types";

export function createPool(connectionString: string): PgTransactionalPool {
  const pool = new pg.Pool({ connectionString });

  return pool as unknown as PgTransactionalPool;
}
