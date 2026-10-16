import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCountCaptureDbFixture } from "./count-capture-db-fixture";
import { captureAuthority, captureSession } from "./count-capture-session-fixture";
import { countCaptureCollectionSchema, validateCountLifecycleReceipt } from "../domain/count-lifecycle-receipt";

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required for the count-capture lifecycle DB proof.");

describe("staging count capture lifecycle", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["catalog"], "count_lifecycle_capture_9587");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("reaches conforming through the ten-action loopback with bounded debits", async () => {
    const fixture = await createCountCaptureDbFixture(pools.catalog);
    const quote = await fixture.prepare();
    await fixture.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint });
    const preview = await fixture.lifecycle.preview(captureSession(), {
      selection: fixture.selection,
      budget: fixture.budget,
    });
    await fixture.lifecycle.preConfirm(captureSession(), {
      selection: fixture.selection,
      budget: fixture.budget,
      planFingerprint: preview.planFingerprint,
    });
    const { receipt } = await fixture.lifecycle.freeze(captureSession(), {
      runnerRunId: "300",
      runnerRunAttempt: 1,
      collection: countCaptureCollectionSchema.parse({
        ...captureAuthority().collection,
        collectedAt: fixture.clock.now,
      }),
    });
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("CONFORMING");
    expect("sends" in receipt ? receipt.sends.length : 0).toBeLessThanOrEqual(11);
  });
});
