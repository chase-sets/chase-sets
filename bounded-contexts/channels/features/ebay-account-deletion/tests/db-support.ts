import { afterAll, beforeAll } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ebayReceiptSchemaSql } from "../read-model/schema";
import { channelCredentialSchemaSql } from "../../credentials/read-model/schema";
import { channelConnectionSchemaSql } from "../../connections/read-model/schema";

export function receiptDatabase(suffix: string, initialize = true) {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL required for enrolled eBay receipt DB proof");
    const urls = createMultiContextTestDatabaseUrls(base, ["channels"], `ebay_receipts_${suffix}`);
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
    if (initialize)
      await pools.channels.query(ebayReceiptSchemaSql + channelConnectionSchemaSql + channelCredentialSchemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  return () => pools.channels;
}
