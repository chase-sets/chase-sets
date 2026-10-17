import { afterAll, beforeAll } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { channelCredentialSchemaSql } from "../read-model/schema";

export function credentialDatabase(suffix: string, initialize = true) {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL is required in the enrolled DB profile");
    const urls = createMultiContextTestDatabaseUrls(base, ["channels"], `credential_${suffix}`);
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
    if (initialize) await pools.channels.query(channelCredentialSchemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  return () => pools.channels;
}

export function credentialReadBarrier() {
  let arrived = 0;
  let release = () => {};
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  return (db: PgQueryable): PgQueryable => ({
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<Row>(sql, values);
      if (sql.startsWith("SELECT") && sql.includes("FROM channels_connection_credentials WHERE row_id")) {
        arrived++;
        if (arrived === 2) release();
        await bothRead;
      }
      return result;
    },
  });
}
