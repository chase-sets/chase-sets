import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../../../index";
import {
  claimReservedPostageOperation,
  listStalePostageOperationLocators,
  reservePostageOperation,
  transitionPostageOperation,
} from "../read-model/postage-operation-authority";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("Shipment mutation authority (issue #7171)", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_7171");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ fulfillment: pool });
    await bootstrapContextDatabase(fulfillmentModule, pool);
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       ) VALUES ('shp_7171','tnt_1','ord_1','acc_buyer','acc_seller','standard','awaiting-label','packed',now(),now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions
       (shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at)
       VALUES ('shp_7171','tnt_1','acc_seller','resolved','authoritative-history',now())`,
    );
  });
  afterAll(async () => closeMultiContextTestPools({ fulfillment: pool }));

  function reserve(keyDigest: string, targetKey = "purchase:shp_7171:initial") {
    return reservePostageOperation(pool, {
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      shipmentId: "shp_7171",
      keyDigest,
      requestHash: `request-${keyDigest}`,
      targetKey,
      operationKind: "purchase-usps-label",
      providerName: "fake-postage",
      providerMode: "test",
      request: { serviceLevel: "USPS_GROUND_ADVANTAGE" },
    });
  }

  it("issue-7171-provider-write-ahead-matrix fences invocation before a provider call and makes unknown terminally ambiguous", async () => {
    const operation = (await reserve("digest-a")).operation;
    const claim = await claimReservedPostageOperation(pool, operation, 60_000);
    expect(claim).not.toBeNull();
    const invoking = await transitionPostageOperation(pool, {
      claim: claim!,
      from: "reserved",
      to: "invoking",
      providerInvoked: true,
    });
    expect(invoking).toMatchObject({ status: "invoking", provider_invoked: true, lifecycle_generation: 1 });
    const ambiguous = await transitionPostageOperation(pool, {
      claim: claim!,
      from: "invoking",
      to: "ambiguous",
      providerInvoked: true,
      closedReason: "invocation-outcome-unknown",
    });
    expect(ambiguous).toMatchObject({ status: "ambiguous", closed_reason: "invocation-outcome-unknown" });
    expect(await claimReservedPostageOperation(pool, ambiguous!)).toBeNull();
  });

  it("issue-7171-provider-active-target-fence gives every losing UUID a non-invoking durable conflict receipt", async () => {
    const [left, right] = await Promise.all([reserve("digest-left"), reserve("digest-right")]);
    const winner = [left, right].find((entry) => !entry.targetConflict)!;
    const loser = [left, right].find((entry) => entry.targetConflict)!;
    expect(winner.operation.status).toBe("reserved");
    expect(loser.operation).toMatchObject({
      status: "failed-safe",
      closed_reason: "active-target-conflict",
      provider_invoked: false,
      provider_idempotency_key: null,
    });
    expect(await reserve(loser.operation.key_digest)).toMatchObject({ targetConflict: true, created: false });
  });

  it("issue-7171-history-tenant-migration-bounds installs the retained tenant ledger and closed lifecycle schema", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fulfillment_postage_label_operations'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "key_digest",
        "request_hash",
        "target_key",
        "claim_token",
        "lifecycle_generation",
      ]),
    );
    const ledger = await pool.query(
      `SELECT status, tenant_id FROM fulfillment_shipment_tenant_resolutions WHERE shipment_id = 'shp_7171'`,
    );
    expect(ledger.rows).toEqual([{ status: "resolved", tenant_id: "tnt_1" }]);
  });

  it("issue-7171-source-worker-webhook-races discovers every resolved tenant through opaque stable pagination", async () => {
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       ) VALUES ('shp_7171_b','tnt_2','ord_2','acc_buyer_2','acc_seller_2','standard','awaiting-label','packed',now(),now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions
       (shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at)
       VALUES ('shp_7171_b','tnt_2','acc_seller_2','resolved','authoritative-history',now())`,
    );
    await reserve("digest-tenant-a", "purchase:shp_7171:tenant-a");
    await reservePostageOperation(pool, {
      tenantId: "tnt_2",
      sellerAccountId: "acc_seller_2",
      shipmentId: "shp_7171_b",
      keyDigest: "digest-tenant-b",
      requestHash: "request-tenant-b",
      targetKey: "purchase:shp_7171_b:tenant-b",
      operationKind: "purchase-usps-label",
      providerName: "fake-postage",
      providerMode: "test",
      request: { serviceLevel: "USPS_GROUND_ADVANTAGE" },
    });
    const first = await listStalePostageOperationLocators(pool, {
      staleBefore: new Date(Date.now() + 60_000).toISOString(),
      limit: 1,
    });
    const second = await listStalePostageOperationLocators(pool, {
      staleBefore: new Date(Date.now() + 60_000).toISOString(),
      afterUpdatedAt: first[0]!.updatedAt,
      afterOperationId: first[0]!.operationId,
      limit: 1,
    });
    const locators = [...first, ...second];

    expect(new Set(locators.map((locator) => locator.tenantId))).toEqual(new Set(["tnt_1", "tnt_2"]));
    expect(Object.keys(locators[0]!).sort()).toEqual(["operationId", "shipmentId", "tenantId", "updatedAt"]);
    expect(JSON.stringify(locators)).not.toContain("digest-tenant");
  });
});
