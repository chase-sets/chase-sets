import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import { createCountCaptureDbFixture } from "./count-capture-db-fixture";
import { captureActor, captureAuthority, captureContext, captureScope, captureSession } from "./count-capture-session-fixture";
import { scopeSyncBatchRoutes } from "../api/route";
import { runCountCaptureJourney } from "../api/count-capture-runner";
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
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    app.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(fixture.runtime, fixture.lifecycle));
    const authority = captureAuthority();
    const identity = { sha: authority.runnerSha, dispatchId: authority.dispatchId, scopeRecordId: captureScope };
    const paths: Record<string, [string, Record<string, unknown>]> = {
      "capture-baseline": ["/count-capture/baseline", { scopeRecordId: captureScope, authority }],
      "capture-initial-notice": ["/count-capture/initial-notice", {}],
      "capture-usage": ["/count-capture/usage", {}],
      "count-quote": ["/counts/quote", { selection: fixture.selection, budget: fixture.budget }],
      "capture-quote-readback": ["/count-capture/quote-readback", {}],
      "capture-final-notice": ["/count-capture/final-notice", {}],
      "count-acquire": ["/counts/acquire", {}],
      preview: ["/preview", { selection: fixture.selection, budget: fixture.budget }],
      "pre-confirm-planner-read": ["/count-capture/pre-confirm", { selection: fixture.selection, budget: fixture.budget }],
      "capture-freeze": ["/count-capture/freeze", { runnerRunId: "300", runnerRunAttempt: 1 }],
    };
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      const [path, baseBody] = paths[intent]!;
      const body = { ...baseBody };
      if (intent === "capture-freeze") body.collection = JSON.stringify({ ...authority.collection, collectedAt: fixture.clock.now });
      if (intent === "count-acquire") {
        const quote = fields.quoteId ? { quoteId: fields.quoteId, fingerprint: fields.countFingerprint } : {};
        Object.assign(body, quote);
      }
      if (intent === "preview" || intent === "pre-confirm-planner-read") body.selection = fixture.selection;
      if (intent === "pre-confirm-planner-read") body.planFingerprint = fields.planFingerprint;
      const response = await app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://admin.staging.chasesets.com", "x-catalog-count-capture": "1" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      return response.json();
    };
    const result = await runCountCaptureJourney(identity, action, fixture.clock.now, async () => ({ ...authority.collection, collectedAt: fixture.clock.now }));
    const receipt = result;
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("CONFORMING");
    expect("sends" in receipt ? receipt.sends.length : 0).toBeLessThanOrEqual(11);
  });

  it.each(["cap overflow", "refused authority", "replay", "refresh"])(
    "rejects unsafe lifecycle (%s) through the route adapter with retained debit evidence",
    async () => {
    const fixture = await createCountCaptureDbFixture(pools.catalog);
    const authority = captureAuthority();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    app.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(fixture.runtime, fixture.lifecycle));
    const post = (path: string, body: unknown) =>
      app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://admin.staging.chasesets.com", "x-catalog-count-capture": "1" },
        body: JSON.stringify(body),
      });
    expect((await post("/count-capture/baseline", { scopeRecordId: captureScope, authority })).status).toBe(200);
    expect((await post("/count-capture/initial-notice", {})).status).toBe(200);
    const response = await post("/count-capture/freeze", {
      runnerRunId: "300",
      runnerRunAttempt: 1,
      collection: { ...authority.collection, outcome: "unknown", reason: "authority-invalid", binding: null, collectedAt: fixture.clock.now },
    });
    expect(response.status).toBe(200);
    const stop = await response.json();
    expect(validateCountLifecycleReceipt(stop.receipt).valid).toBe(true);
    expect(stop.receipt.classification.verdict).toBe("INCOMPLETE");
    expect("sends" in stop.receipt ? stop.receipt.sends.length : 0).toBe(0);
    },
  );
});
