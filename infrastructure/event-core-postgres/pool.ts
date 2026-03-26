import pg from "pg";
import type { PgTransactionalPool } from "./types";

export function createPgPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}
