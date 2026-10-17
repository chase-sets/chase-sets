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
import {
  captureActor,
  captureAuthority,
  captureContext,
  captureScope,
  captureSession,
} from "./count-capture-session-fixture";
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
    const app = new Hono<{ Variables: { context: typeof captureContext; actor: ReturnType<typeof captureActor> } }>();
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
      "pre-confirm-planner-read": [
        "/count-capture/pre-confirm",
        { selection: fixture.selection, budget: fixture.budget },
      ],
      "capture-freeze": ["/count-capture/freeze", { runnerRunId: "300", runnerRunAttempt: 1 }],
    };
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      const [path, baseBody] = paths[intent]!;
      const body = { ...baseBody };
      if (intent === "capture-freeze") body.collection = { ...authority.collection, collectedAt: fixture.clock.now };
      if (intent === "count-acquire") {
        const quote = fields.quoteId ? { quoteId: fields.quoteId, fingerprint: fields.countFingerprint } : {};
        Object.assign(body, quote);
      }
      if (intent === "preview" || intent === "pre-confirm-planner-read") body.selection = fixture.selection;
      if (intent === "pre-confirm-planner-read") body.planFingerprint = fields.planFingerprint;
      const response = await app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://admin.staging.chasesets.com",
          "x-catalog-count-capture": "1",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      return response.json();
    };
    const result = await runCountCaptureJourney(
      identity,
      action,
      () => fixture.clock.now,
      async () => countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt: fixture.clock.now }),
    );
    const receipt = result;
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("CONFORMING");
    expect("sends" in receipt ? receipt.sends.length : 0).toBeLessThanOrEqual(11);
  });

  it.each([
    ["cap overflow", "cap-overflow"],
    ["refused authority", "invalid-acquire"],
    ["replay", "duplicate-acquire"],
    ["refresh", "scope-refresh"],
  ])("rejects unsafe lifecycle (%s) through the runner path with retained debit evidence", async ([_label, mode]) => {
    const fixture = await createCountCaptureDbFixture(pools.catalog);
    const authority = captureAuthority();
    const app = new Hono<{ Variables: { context: typeof captureContext; actor: ReturnType<typeof captureActor> } }>();
    app.use("*", async (c, next) => {
      c.set("context", captureContext);
      c.set("actor", captureActor());
      await next();
    });
    app.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(fixture.runtime, fixture.lifecycle));
    const post = (path: string, body: unknown) =>
      app.request(`https://admin.staging.chasesets.com/api/catalog/scope-sync-batches${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://admin.staging.chasesets.com",
          "x-catalog-count-capture": "1",
        },
        body: JSON.stringify(body),
      });
    const identity = { sha: authority.runnerSha, dispatchId: authority.dispatchId, scopeRecordId: captureScope };
    let acquisitionBody: Record<string, unknown> | undefined;
    const action = async (intent: string, fields: Readonly<Record<string, string>>) => {
      const body: Record<string, unknown> = (() => {
        switch (intent) {
          case "capture-baseline":
            return { scopeRecordId: captureScope, authority };
          case "capture-initial-notice":
          case "capture-usage":
          case "capture-quote-readback":
          case "capture-final-notice":
            return {};
          case "count-quote":
            return { selection: fixture.selection, budget: fixture.budget };
          case "count-acquire":
            return { quoteId: fields.quoteId, fingerprint: fields.countFingerprint };
          case "preview":
            return { selection: fixture.selection, budget: fixture.budget };
          case "pre-confirm-planner-read":
            return { selection: fixture.selection, budget: fixture.budget, planFingerprint: fields.planFingerprint };
          case "capture-freeze":
            return { runnerRunId: "300", runnerRunAttempt: 1, collection: JSON.parse(fields.collection) };
          default:
            throw new Error(`unknown-intent-${intent}`);
        }
      })();
      if (intent === "count-acquire") {
        acquisitionBody = body;
        if (mode === "invalid-acquire") {
          const refused = await post("/counts/acquire", { quoteId: fields.quoteId, fingerprint: "f".repeat(64) });
          expect(refused.ok).toBe(false);
        }
      }
      if (intent === "capture-freeze")
        body.collection = {
          ...authority.collection,
          outcome: "unknown",
          reason: "authority-invalid",
          binding: null,
          collectedAt: mode === "scope-refresh" ? "2026-10-13T08:05:00.000Z" : fixture.clock.now,
        };
      const response = await post(paths[intent]![0], body);
      const value = await response.json();
      if (!response.ok) throw new Error(`action-${intent}-${response.status}`);
      if ((mode === "cap-overflow" || mode === "replay") && intent === "count-acquire") {
        const repeats = mode === "cap-overflow" ? 2 : 1;
        for (let index = 0; index < repeats; index++) {
          const replay = await post("/counts/acquire", acquisitionBody);
          expect(replay.ok).toBe(false);
        }
      }
      return value;
    };
    const result = await runCountCaptureJourney(
      identity,
      action,
      () => fixture.clock.now,
      async () => countCaptureCollectionSchema.parse({ ...authority.collection, collectedAt: fixture.clock.now }),
    );
    expect(validateCountLifecycleReceipt(result).valid).toBe(true);
    expect(result.classification.verdict).toBe("INCOMPLETE");
    expect("sends" in result ? result.sends.length : 0).toBeGreaterThan(0);
  });
});
