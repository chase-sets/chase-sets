import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { DiscoveryApiEnv } from "../api";
import { createGoogleShoppingSyncRoutes } from "../support/google-shopping-support/route";
import {
  classifyGoogleShoppingSyncRow,
  previewGoogleShoppingMaintenanceSync,
  processGoogleShoppingSyncRow,
  type GoogleShoppingFeedRowForSync,
  type GoogleShoppingMaintenancePreview,
  type GoogleShoppingSyncMerchantClient,
  type GoogleShoppingSyncProviderResult,
  type GoogleShoppingSyncServices,
} from "../support/google-shopping-support/sync-job";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_ops" as never,
  },
};

const payload = {
  offerId: "cs-listing-lst_1",
  title: "Charizard",
  description: "Base Set card.",
  link: "https://www.chasesets.com/listings/charizard",
  imageLink: "https://assets.chasesets.com/charizard.jpg",
  priceAmount: "42.00",
  currencyCode: "USD",
  availability: "in stock",
  condition: "used",
  externalSellerId: "cs-account-acc_1",
  targetCountry: "US",
  contentLanguage: "en",
  feedLabel: "US",
} as const;

describe("google shopping sync row processing", () => {
  it("classifies unchanged eligible rows as skipped", () => {
    expect(
      classifyGoogleShoppingSyncRow(
        row({
          payloadHash: "hash_1",
          lastSubmittedPayloadHash: "hash_1",
        }),
      ),
    ).toEqual({ action: "skip", reason: "unchanged" });
  });

  it("classifies deleted eligible rows as resubmits even when the payload hash matches", () => {
    expect(
      classifyGoogleShoppingSyncRow(
        row({
          payloadHash: "hash_1",
          lastSubmittedPayloadHash: "hash_1",
          deleteSubmittedAt: "2026-06-01T00:00:00.000Z",
          syncStatus: "deleted",
        }),
      ),
    ).toEqual({ action: "submit", reason: "resubmit-after-delete" });
  });

  it("submits changed live rows and persists submitted metadata", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "insert-product-input",
          attempts: 1,
          request: { body: payload },
        }),
      ),
      deleteProductInput: vi.fn(),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ payloadHash: "hash_2", lastSubmittedPayloadHash: "hash_1" }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("submitted");
    expect(client.insertOrUpdateProductInput).toHaveBeenCalledWith(payload, expect.any(Object));
    expect(db.queries.at(-1)?.sql).toContain("SET sync_status = 'submitted'");
    expect(db.queries.at(-1)?.values).toContain("hash_2");
  });

  it("does not mutate row sync state during dry-run submissions", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "dry-run",
          operation: "insert-product-input",
          attempts: 0,
          request: { body: payload },
        }),
      ),
      deleteProductInput: vi.fn(),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ payloadHash: "hash_2", lastSubmittedPayloadHash: "hash_1" }),
      mode: "dry-run",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("submitted");
    expect(db.queries).toHaveLength(0);
  });

  it("forces a full submission for scheduled refresh even when the row is unchanged", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "insert-product-input",
          attempts: 1,
          request: { body: payload },
        }),
      ),
      patchPriceAndAvailability: vi.fn(),
      deleteProductInput: vi.fn(),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ payloadHash: "hash_1", lastSubmittedPayloadHash: "hash_1" }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
      forceSubmit: true,
      preferredOperation: "full",
    });

    expect(outcome).toBe("submitted");
    expect(client.insertOrUpdateProductInput).toHaveBeenCalledWith(payload, expect.any(Object));
    expect(client.patchPriceAndAvailability).not.toHaveBeenCalled();
    expect(db.queries.at(-1)?.sql).toContain("SET sync_status = 'submitted'");
  });

  it("deletes tombstoned rows that had a prior submission", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      deleteProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "delete-product-input",
          attempts: 1,
        }),
      ),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ tombstoneStatus: "withdrawn", lastSubmittedPayloadHash: "hash_1" }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("deleted");
    expect(client.deleteProductInput).toHaveBeenCalledWith("cs-listing-lst_1", expect.any(Object));
    expect(db.queries.at(-1)?.sql).toContain("SET sync_status = 'deleted'");
  });

  it("deletes rows that become ineligible after a prior submission", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      deleteProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "delete-product-input",
          attempts: 1,
        }),
      ),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({
        eligibilityStatus: "excluded",
        exclusionReasons: ["seller-unavailable"],
        payload: null,
        payloadHash: null,
        lastSubmittedPayloadHash: "hash_1",
      }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("deleted");
    expect(client.deleteProductInput).toHaveBeenCalledWith("cs-listing-lst_1", expect.any(Object));
  });

  it("patches price and availability for incremental price-only changes", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      patchPriceAndAvailability: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "patch-product-input",
          attempts: 1,
          request: { updateMask: ["productAttributes.price", "productAttributes.availability"] },
        }),
      ),
      deleteProductInput: vi.fn(),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ payloadHash: "hash_2", lastSubmittedPayloadHash: "hash_1" }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
      preferredOperation: "patch-price-availability",
    });

    expect(outcome).toBe("submitted");
    expect(client.patchPriceAndAvailability).toHaveBeenCalledWith(
      "cs-listing-lst_1",
      { priceAmount: "42.00", currencyCode: "USD", availability: "in stock" },
      expect.any(Object),
    );
    expect(client.insertOrUpdateProductInput).not.toHaveBeenCalled();
    expect(db.queries.at(-1)?.values).toContain("patch-product-input");
  });

  it("records provider failures without throwing the row processor", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "permanent-failure",
          operation: "insert-product-input",
          attempts: 1,
          error: {
            code: "invalid_argument",
            message: "Missing required attribute.",
            httpStatus: 400,
            retryable: false,
            providerRequestId: "req_1",
          },
        }),
      ),
      deleteProductInput: vi.fn(),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ payloadHash: "hash_2", lastSubmittedPayloadHash: "hash_1" }),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("failed");
    expect(db.queries.at(-1)?.sql).toContain("SET sync_status = 'failed'");
    expect(db.queries.at(-1)?.values).toContain("invalid_argument");
    expect(db.queries.at(-1)?.values).toContain("req_1");
  });

  it("previews cleanup before refresh candidates with an explicit refresh cutoff", async () => {
    const db = maintenanceDb();

    const summary = await previewGoogleShoppingMaintenanceSync(db, {
      mode: "dry-run",
      now: "2026-06-03T12:00:00.000Z",
      refreshWindowDays: 25,
      limit: 10,
    });

    expect(summary).toMatchObject({
      mode: "dry-run",
      refreshWindowDays: 25,
      refreshCutoff: "2026-05-09T12:00:00.000Z",
      retentionDays: 90,
      total: 2,
      cleanup: [{ action: "cleanup", listingId: "lst_cleanup", merchantOfferId: "cs-listing-lst_cleanup" }],
      refresh: [{ action: "refresh", listingId: "lst_refresh", merchantOfferId: "cs-listing-lst_refresh" }],
    });
    expect(db.queries[0]?.sql).toContain("delete_submitted_at IS NULL");
    expect(db.queries[1]?.sql).toContain("COALESCE(last_accepted_at, last_submitted_at) <= $1::timestamptz");
    expect(db.queries[1]?.values[0]).toBe("2026-05-09T12:00:00.000Z");
  });
});

describe("google shopping sync routes", () => {
  it("requires security.manage to enqueue a sync job", async () => {
    const enqueueFullSyncJob = vi.fn();
    const app = createAuthenticatedApp({ enqueueFullSyncJob }, ["pricing.manage"]);

    const response = await app.request("/sync-jobs", {
      method: "POST",
      body: JSON.stringify({ mode: "dry-run" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(enqueueFullSyncJob).not.toHaveBeenCalled();
  });

  it("enqueues dry-run sync jobs for security operators", async () => {
    const enqueueFullSyncJob = vi.fn(async () => jobSnapshot("job_sync"));
    const app = createAuthenticatedApp({ enqueueFullSyncJob }, ["security.manage"]);

    const response = await app.request("/sync-jobs", {
      method: "POST",
      body: JSON.stringify({ mode: "dry-run", batchSize: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_sync",
      status: "queued",
    });
    expect(enqueueFullSyncJob).toHaveBeenCalledWith({ mode: "dry-run", batchSize: 25 }, context);
  });

  it("previews maintenance candidates for security operators", async () => {
    const summary = maintenanceSummary();
    const previewMaintenanceSync = vi.fn(async () => summary);
    const app = createAuthenticatedApp({ previewMaintenanceSync }, ["security.manage"]);

    const response = await app.request("/maintenance/preview?mode=dry-run&refreshWindowDays=25&limit=2");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      cleanup: [{ listingId: "lst_cleanup" }],
      refresh: [{ listingId: "lst_refresh" }],
    });
    expect(previewMaintenanceSync).toHaveBeenCalledWith({
      mode: "dry-run",
      refreshWindowDays: 25,
      limit: 2,
    });
  });

  it("enqueues maintenance sync jobs with exact dry-run summary", async () => {
    const summary = maintenanceSummary();
    const enqueueMaintenanceSyncJob = vi.fn(async () => ({
      summary,
      job: jobSnapshot("job_maintenance"),
    }));
    const app = createAuthenticatedApp({ enqueueMaintenanceSyncJob }, ["security.manage"]);

    const response = await app.request("/maintenance/sync-jobs", {
      method: "POST",
      body: JSON.stringify({ mode: "dry-run", refreshWindowDays: 25, limit: 2 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      summary: { total: 2 },
      job: { jobId: "job_maintenance", status: "queued" },
    });
    expect(enqueueMaintenanceSyncJob).toHaveBeenCalledWith(
      { mode: "dry-run", refreshWindowDays: 25, limit: 2 },
      context,
    );
  });
});

function row(overrides: Partial<GoogleShoppingFeedRowForSync> = {}): GoogleShoppingFeedRowForSync {
  return {
    rowId: "google-shopping:listing:lst_1",
    listingId: "lst_1",
    merchantOfferId: "cs-listing-lst_1",
    payload,
    payloadHash: "hash_1",
    eligibilityStatus: "eligible",
    exclusionReasons: [],
    syncStatus: "never-submitted",
    lastSubmittedPayloadHash: null,
    tombstoneStatus: "live",
    deleteSubmittedAt: null,
    ...overrides,
  };
}

function recordingDb(): PgQueryable & { queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };
}

function maintenanceDb(): PgQueryable & { queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("tombstone_status <> 'live' OR eligibility_status <> 'eligible'")) {
        return {
          rows: [
            maintenanceCandidateRow({
              action: "cleanup",
              row_id: "google-shopping:listing:lst_cleanup",
              listing_id: "lst_cleanup",
              merchant_offer_id: "cs-listing-lst_cleanup",
              eligibility_status: "excluded",
              tombstone_status: "live",
              sync_status: "submitted",
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("COALESCE(last_accepted_at, last_submitted_at) <= $1::timestamptz")) {
        return {
          rows: [
            maintenanceCandidateRow({
              action: "refresh",
              row_id: "google-shopping:listing:lst_refresh",
              listing_id: "lst_refresh",
              merchant_offer_id: "cs-listing-lst_refresh",
              eligibility_status: "eligible",
              tombstone_status: "live",
              sync_status: "submitted",
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function testJobContext() {
  return {
    throwIfCancelled: vi.fn(),
    renew: vi.fn(async () => undefined),
    checkpointProgress: vi.fn(async () => undefined),
  };
}

function createAuthenticatedApp(services: unknown, permissions: readonly string[] | null) {
  const app = new Hono<DiscoveryApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_test",
            tenantId: "tnt_test",
            userId: "usr_test",
            accountId: "acc_ops",
            membershipId: "mem_test",
            roleKey: "platform-admin",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", createGoogleShoppingSyncRoutes(services as GoogleShoppingSyncServices));
  return app;
}

function maintenanceSummary(): GoogleShoppingMaintenancePreview {
  return {
    mode: "dry-run",
    refreshWindowDays: 25,
    refreshCutoff: "2026-05-09T12:00:00.000Z",
    limit: 2,
    retentionDays: 90,
    cleanup: [
      {
        action: "cleanup",
        rowId: "google-shopping:listing:lst_cleanup",
        listingId: "lst_cleanup",
        merchantOfferId: "cs-listing-lst_cleanup",
        eligibilityStatus: "excluded",
        tombstoneStatus: "live",
        syncStatus: "submitted",
        payloadHash: "hash_cleanup",
        lastSubmittedPayloadHash: "hash_cleanup",
        lastSubmittedAt: "2026-05-01T00:00:00.000Z",
        lastAcceptedAt: null,
        deleteSubmittedAt: null,
      },
    ],
    refresh: [
      {
        action: "refresh",
        rowId: "google-shopping:listing:lst_refresh",
        listingId: "lst_refresh",
        merchantOfferId: "cs-listing-lst_refresh",
        eligibilityStatus: "eligible",
        tombstoneStatus: "live",
        syncStatus: "submitted",
        payloadHash: "hash_refresh",
        lastSubmittedPayloadHash: "hash_refresh",
        lastSubmittedAt: "2026-05-01T00:00:00.000Z",
        lastAcceptedAt: "2026-05-02T00:00:00.000Z",
        deleteSubmittedAt: null,
      },
    ],
    total: 2,
  };
}

function maintenanceCandidateRow(overrides: Record<string, unknown>) {
  return {
    payload_hash: "hash_1",
    last_submitted_payload_hash: "hash_1",
    last_submitted_at: "2026-05-01T00:00:00.000Z",
    last_accepted_at: null,
    delete_submitted_at: null,
    ...overrides,
  };
}

function jobSnapshot(jobId: string) {
  return {
    jobId,
    jobKind: "full-sync",
    status: "queued" as const,
    payload: {
      mode: "dry-run" as const,
      batchSize: 25,
      requestedByUserId: "usr_test",
      requestedForAccountId: "acc_ops",
    },
    progress: {
      phase: "queued" as const,
      completed: 0,
      total: 0,
      currentRowId: null,
      submitted: 0,
      skipped: 0,
      deleted: 0,
      failed: 0,
      excluded: 0,
      message: "Google Shopping full sync queued.",
    },
    result: null,
    errorMessage: null,
    eventContext: context,
    claimOwnerId: null,
    claimedUntil: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}
