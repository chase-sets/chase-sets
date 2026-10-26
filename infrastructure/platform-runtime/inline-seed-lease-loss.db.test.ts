import { describe, expect, it, vi } from "vitest";
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

describeDb("inline seed lease loss", () => {
  let pools: Readonly<Record<"platform", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["platform"], "inline_seed_lease_loss");
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

  it("refuses an already-aborted acquisition without creating a lease or running work", async () => {
    await bootstrapPlatformControlPlane(pools.platform);
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const port = createProjectionGroupLeasePort(controlPlane, "platform-api");
    const signal = AbortSignal.abort();
    const work = vi.fn(async () => undefined);

    await expect(
      port.runWithLease({ targetContextName: "catalog", projectionName: "catalog-items" }, signal, work),
    ).rejects.toThrow(/cancelled before acquisition/);
    expect(work).not.toHaveBeenCalled();
    await expect(controlPlane.listLeases()).resolves.toEqual([]);
  });

  it("waits inside the caller abort budget and never acquires after rejection", async () => {
    await bootstrapPlatformControlPlane(pools.platform);
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const holder = await controlPlane.acquireLease({
      leaseName: "projection-group:catalog.catalog-items",
      ownerId: "operation:held",
      ttlMs: 120_000,
      metadata: { origin: "projection-operation" },
    });
    expect(holder).not.toBeNull();

    const port = createProjectionGroupLeasePort(controlPlane, "platform-api");
    const abort = new AbortController();
    const work = vi.fn(async () => undefined);
    const rejected = port.runWithLease(
      { targetContextName: "catalog", projectionName: "catalog-items" },
      abort.signal,
      work,
    );
    setTimeout(() => abort.abort(), 150);
    await expect(rejected).rejects.toThrow(/cancelled|aborted/);
    expect(work).not.toHaveBeenCalled();

    await controlPlane.releaseLease(holder!);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(controlPlane.listLeases()).resolves.toEqual([]);
  });
});
