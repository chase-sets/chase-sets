import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  platformControlPlaneSchemaSql,
} from "./control-plane";
import { createProjectionGroupLeasePort } from "./api";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("inline seed group lease", () => {
  let pools: Readonly<Record<"platform", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["platform"], "inline_seed_group_lease");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.platform.query(eventCorePostgresSchemaSql);
    await pools.platform.query(platformControlPlaneSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("records one owner/token and releases it after the fenced drain", async () => {
    await bootstrapPlatformControlPlane(pools.platform);
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const port = createProjectionGroupLeasePort(controlPlane, "platform-api");

    await port.runWithLease(
      { targetContextName: "catalog", projectionName: "catalog-items" },
      undefined,
      async (context) => {
        expect(context.ownerId).toBe("seed:platform-api");
        expect(context.fencingToken).toMatch(/^\d+$/);
        const lease = await controlPlane.listLeases();
        expect(lease).toHaveLength(1);
        expect(lease[0]).toMatchObject({
          lease_name: "projection-group:catalog.catalog-items",
          owner_id: "seed:platform-api",
        });
      },
    );

    await expect(controlPlane.listLeases()).resolves.toEqual([]);
  });
});
