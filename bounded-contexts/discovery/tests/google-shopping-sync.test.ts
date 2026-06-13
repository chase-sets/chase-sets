import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { DiscoveryApiEnv } from "../api";
import { createGoogleShoppingSyncRoutes } from "../support/google-shopping-support/route";
import {
  classifyGoogleShoppingSyncRow,
  createGoogleShoppingSyncRuntime,
  normalizeGoogleShoppingDiagnostics,
  previewGoogleShoppingMaintenanceSync,
  processGoogleShoppingDiagnosticsRow,
  processGoogleShoppingSyncRow,
  type GoogleShoppingDiagnosticIssueSnapshot,
  type GoogleShoppingFeedRowForSync,
  type GoogleShoppingMaintenancePreview,
  type GoogleShoppingProductDiagnostics,
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
const now = "2026-06-03T12:00:00.000Z";

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

  it("prepares dry-run deletes without mutating submitted row state", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      deleteProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "dry-run",
          operation: "delete-product-input",
          attempts: 0,
          request: { method: "DELETE" },
        }),
      ),
    };

    const outcome = await processGoogleShoppingSyncRow({
      db,
      row: row({ tombstoneStatus: "withdrawn", lastSubmittedPayloadHash: "hash_1" }),
      mode: "dry-run",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toBe("deleted");
    expect(client.deleteProductInput).toHaveBeenCalledWith("cs-listing-lst_1", expect.any(Object));
    expect(db.queries).toHaveLength(0);
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

  it("records exhausted transient provider failures for retry visibility", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "transient-failure",
          operation: "insert-product-input",
          attempts: 3,
          error: {
            code: "unavailable",
            message: "Google Merchant API retries were exhausted.",
            httpStatus: 503,
            retryable: true,
            providerRequestId: "req_retry",
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
    expect(db.queries.at(-1)?.values).toContain("unavailable");
    expect(db.queries.at(-1)?.values).toContain("req_retry");
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

describe("google shopping diagnostics", () => {
  it("normalizes provider issues with first and last seen timestamps", () => {
    const normalized = normalizeGoogleShoppingDiagnostics([], diagnostics([issue({ code: "invalid_gtin" })]), now);

    expect(normalized).toMatchObject({
      status: "disapproved",
      resolvedIssues: 0,
      activeIssues: [
        {
          code: "invalid_gtin",
          severity: "DISAPPROVED",
          firstSeenAt: now,
          lastSeenAt: now,
          resolvedAt: null,
          known: true,
        },
      ],
    });
  });

  it("marks missing previous issues as resolved", () => {
    const normalized = normalizeGoogleShoppingDiagnostics(
      [
        {
          code: "invalid_gtin",
          severity: "DISAPPROVED",
          resolution: "merchant_action",
          attribute: "gtins",
          reportingContext: "FREE_LISTINGS",
          description: "Invalid GTIN",
          detail: "Fix the GTIN.",
          documentation: "https://support.google.com/merchants/answer/6324461",
          applicableCountries: ["US"],
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: "2026-06-02T00:00:00.000Z",
          resolvedAt: null,
          known: true,
        },
      ],
      diagnostics([]),
      now,
    );

    expect(normalized).toMatchObject({
      status: "approved",
      resolvedIssues: 1,
      issues: [{ code: "invalid_gtin", resolvedAt: now }],
    });
  });

  it("preserves unknown provider issue codes for launch evidence", () => {
    const normalized = normalizeGoogleShoppingDiagnostics(
      [],
      diagnostics([issue({ code: "brand_new_policy_code", severity: "WARNING" })]),
      now,
    );

    expect(normalized.status).toBe("approved_with_issues");
    expect(normalized.activeIssues).toEqual([
      expect.objectContaining({ code: "brand_new_policy_code", known: false, severity: "WARNING" }),
    ]);
  });

  it("persists live diagnostics without mutating sync submission state", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      deleteProductInput: vi.fn(),
      getProcessedProductStatus: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "success",
          operation: "get-processed-product",
          attempts: 1,
          diagnostics: diagnostics([issue({ code: "invalid_gtin" })]),
          request: { method: "GET" },
        }),
      ),
    };

    const outcome = await processGoogleShoppingDiagnosticsRow({
      db,
      row: diagnosticsRow(),
      mode: "live",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toMatchObject({ outcome: "checked", status: "disapproved", activeIssues: 1 });
    expect(client.getProcessedProductStatus).toHaveBeenCalledWith("cs-listing-lst_1", expect.any(Object));
    expect(db.queries.at(-1)?.sql).toContain("diagnostic_destination_statuses");
    expect(db.queries.at(-1)?.sql).not.toContain("last_submitted_payload_hash");
    expect(JSON.parse(String(db.queries.at(-1)?.values[3]))).toEqual([
      expect.objectContaining({ code: "invalid_gtin", firstSeenAt: expect.any(String), resolvedAt: null }),
    ]);
  });

  it("reconciles previous diagnostics in chunks with output identical to single-pass behavior", async () => {
    vi.useFakeTimers({ now: new Date(now) });
    try {
      const previousIssues = [
        previousDiagnosticIssue({
          code: "invalid_gtin",
          attribute: "gtins",
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: "2026-06-02T00:00:00.000Z",
        }),
        previousDiagnosticIssue({
          code: "missing_price",
          attribute: "price",
          firstSeenAt: "2026-05-30T00:00:00.000Z",
          lastSeenAt: "2026-06-02T00:00:00.000Z",
        }),
        previousDiagnosticIssue({
          code: "price_mismatch",
          attribute: "price",
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "2026-05-29T00:00:00.000Z",
          resolvedAt: "2026-05-29T00:00:00.000Z",
        }),
        previousDiagnosticIssue({
          code: "brand_new_policy_code",
          severity: "WARNING",
          attribute: "image_link",
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: "2026-06-02T00:00:00.000Z",
          resolvedAt: "2026-06-02T00:00:00.000Z",
          known: false,
        }),
      ];
      const currentDiagnostics = diagnostics([
        issue({ code: "invalid_gtin", attribute: "gtins" }),
        issue({ code: "brand_new_policy_code", severity: "WARNING", attribute: "image_link" }),
      ]);

      const chunked = await runDiagnosticsRow(previousIssues, currentDiagnostics, 2);
      const singlePass = await runDiagnosticsRow(previousIssues, currentDiagnostics, 100);

      expect(chunked).toEqual(singlePass);
      expect(chunked.persistedIssues).toEqual([
        expect.objectContaining({
          code: "invalid_gtin",
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: now,
          resolvedAt: null,
        }),
        expect.objectContaining({
          code: "brand_new_policy_code",
          firstSeenAt: now,
          lastSeenAt: now,
          resolvedAt: null,
        }),
        expect.objectContaining({ code: "missing_price", resolvedAt: now }),
        expect.objectContaining({ code: "price_mismatch", resolvedAt: "2026-05-29T00:00:00.000Z" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips dry-run diagnostics without mutating row state", async () => {
    const db = recordingDb();
    const client: GoogleShoppingSyncMerchantClient = {
      insertOrUpdateProductInput: vi.fn(),
      deleteProductInput: vi.fn(),
      getProcessedProductStatus: vi.fn(
        async (): Promise<GoogleShoppingSyncProviderResult> => ({
          status: "dry-run",
          operation: "get-processed-product",
          attempts: 0,
          request: { method: "GET" },
        }),
      ),
    };

    const outcome = await processGoogleShoppingDiagnosticsRow({
      db,
      row: diagnosticsRow(),
      mode: "dry-run",
      merchantClient: client,
      jobContext: testJobContext(),
    });

    expect(outcome).toEqual({
      outcome: "skipped",
      status: "unknown",
      activeIssues: 0,
      unknownIssueCodes: 0,
      resolvedIssues: 0,
    });
    expect(client.getProcessedProductStatus).toHaveBeenCalledWith("cs-listing-lst_1", expect.any(Object));
    expect(db.queries).toHaveLength(0);
  });

  it("builds launch-impact snapshots from persisted diagnostic issue state", async () => {
    const runtime = createGoogleShoppingSyncRuntime({
      db: diagnosticsSnapshotDb(),
    });

    const snapshot = await runtime.getDiagnosticsSnapshot({ limit: 10 });

    expect(snapshot).toMatchObject({
      totals: {
        rows: 2,
        disapproved: 1,
        approvedWithIssues: 1,
      },
      activeIssueSeverityCounts: {
        DISAPPROVED: 1,
        WARNING: 1,
      },
      unknownIssueCodeCount: 1,
      launchImpact: {
        p0: true,
        p1: true,
        reasons: [
          "1 submitted Google Shopping row(s) are disapproved.",
          "1 active provider issue code(s) are unknown.",
        ],
      },
    });
  });

  it("lists operator feed rows with filters, remediation owners, and redacted provider state", async () => {
    const db = feedRowListDb();
    const runtime = createGoogleShoppingSyncRuntime({ db });

    const list = await runtime.listFeedRows({
      filter: "failed",
      search: "lst_1",
      refreshWindowDays: 25,
      now,
      limit: 10,
    });

    expect(list).toMatchObject({
      filter: "failed",
      search: "lst_1",
      refreshWindowDays: 25,
      summary: {
        totalRows: 3,
        failedRows: 1,
        disapprovedRows: 1,
        pendingDeleteRows: 1,
        staleRows: 1,
      },
      rows: [
        {
          rowId: "google-shopping:listing:lst_1",
          listingId: "lst_1",
          accountId: "acc_1",
          catalogItemId: "cit_1",
          productId: "prd_1",
          merchantOfferId: "cs-listing-lst_1",
          eligibilityStatus: "excluded",
          syncStatus: "failed",
          diagnosticStatus: "disapproved",
          pendingDelete: true,
          stale: false,
          unknownIssueCodeCount: 1,
          lastProviderOperation: "insert-product-input",
        },
      ],
    });
    expect(list.rows[0]).not.toHaveProperty("lastProviderResponse");
    expect(list.rows[0]?.remediationOwners).toEqual(
      expect.arrayContaining(["Catalog", "Public Presence", "Platform Runtime", "Ops / Google Merchant Center"]),
    );
    expect(db.queries[1]?.sql).toContain("sync_status = 'failed'");
    expect(db.queries[1]?.sql).toContain("lower(listing_id)");
  });
});

describe("google shopping sync routes", () => {
  it("requires google-shopping.manage to enqueue a sync job", async () => {
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
    const app = createAuthenticatedApp({ enqueueFullSyncJob }, ["google-shopping.manage"]);

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
    const app = createAuthenticatedApp({ previewMaintenanceSync }, ["google-shopping.manage"]);

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
    const app = createAuthenticatedApp({ enqueueMaintenanceSyncJob }, ["google-shopping.manage"]);

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

  it("returns diagnostics snapshots for security operators", async () => {
    const getDiagnosticsSnapshot = vi.fn(async () => diagnosticsSnapshot());
    const app = createAuthenticatedApp({ getDiagnosticsSnapshot }, ["google-shopping.manage"]);

    const response = await app.request("/diagnostics/snapshot?limit=50");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totals: { rows: 1, disapproved: 1 },
      launchImpact: { p0: true },
      rows: [{ listingId: "lst_1", accountId: "acc_1" }],
    });
    expect(getDiagnosticsSnapshot).toHaveBeenCalledWith({ limit: 50 });
  });

  it("requires google-shopping.manage to inspect feed rows", async () => {
    const listFeedRows = vi.fn();
    const app = createAuthenticatedApp({ listFeedRows }, ["pricing.manage"]);

    const response = await app.request("/feed-rows?filter=failed");

    expect(response.status).toBe(403);
    expect(listFeedRows).not.toHaveBeenCalled();
  });

  it("lists feed rows for security operators with parsed filters", async () => {
    const listFeedRows = vi.fn(async () => feedRowListResponse());
    const app = createAuthenticatedApp({ listFeedRows }, ["google-shopping.manage"]);

    const response = await app.request("/feed-rows?filter=disapproved&search=lst_1&limit=25&refreshWindowDays=20");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      filter: "disapproved",
      rows: [{ listingId: "lst_1", diagnosticStatus: "disapproved" }],
    });
    expect(listFeedRows).toHaveBeenCalledWith({
      filter: "disapproved",
      search: "lst_1",
      limit: 25,
      refreshWindowDays: 20,
    });
  });

  it("enqueues diagnostics refresh jobs for security operators", async () => {
    const enqueueDiagnosticsRefreshJob = vi.fn(async () => jobSnapshot("job_diagnostics"));
    const app = createAuthenticatedApp({ enqueueDiagnosticsRefreshJob }, ["google-shopping.manage"]);

    const response = await app.request("/diagnostics/refresh-jobs", {
      method: "POST",
      body: JSON.stringify({ mode: "dry-run", batchSize: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_diagnostics", status: "queued" });
    expect(enqueueDiagnosticsRefreshJob).toHaveBeenCalledWith({ mode: "dry-run", batchSize: 25 }, context);
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

function diagnosticsRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "google-shopping:listing:lst_1",
    listingId: "lst_1",
    accountId: "acc_1",
    catalogItemId: "cit_1",
    productId: "prd_1",
    merchantOfferId: "cs-listing-lst_1",
    externalSellerId: "cs-account-acc_1",
    diagnosticIssues: [],
    ...overrides,
  };
}

function diagnostics(
  issues: readonly GoogleShoppingProductDiagnostics["issues"][number][],
): GoogleShoppingProductDiagnostics {
  return {
    productName: "accounts/[account]/products/product",
    destinationStatuses: [{ reportingContext: "FREE_LISTINGS", approvedCountries: ["US"] }],
    issues,
  };
}

function issue(overrides: Partial<GoogleShoppingProductDiagnostics["issues"][number]> = {}) {
  return {
    code: "invalid_gtin",
    severity: "DISAPPROVED",
    resolution: "merchant_action",
    attribute: "gtins",
    reportingContext: "FREE_LISTINGS",
    description: "Invalid GTIN",
    detail: "The value provided for the gtin attribute is not a valid GTIN.",
    documentation: "https://support.google.com/merchants/answer/6324461",
    applicableCountries: ["US"],
    ...overrides,
  };
}

function previousDiagnosticIssue(
  overrides: Partial<GoogleShoppingDiagnosticIssueSnapshot> = {},
): GoogleShoppingDiagnosticIssueSnapshot {
  return {
    code: "invalid_gtin",
    severity: "DISAPPROVED",
    resolution: "merchant_action",
    attribute: "gtins",
    reportingContext: "FREE_LISTINGS",
    description: "Invalid GTIN",
    detail: "The value provided for the gtin attribute is not a valid GTIN.",
    documentation: "https://support.google.com/merchants/answer/6324461",
    applicableCountries: ["US"],
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-06-02T00:00:00.000Z",
    resolvedAt: null,
    known: true,
    ...overrides,
  };
}

async function runDiagnosticsRow(
  previousIssues: readonly GoogleShoppingDiagnosticIssueSnapshot[],
  currentDiagnostics: GoogleShoppingProductDiagnostics,
  previousIssueChunkSize: number,
) {
  const db = recordingDb();
  const client: GoogleShoppingSyncMerchantClient = {
    insertOrUpdateProductInput: vi.fn(),
    deleteProductInput: vi.fn(),
    getProcessedProductStatus: vi.fn(
      async (): Promise<GoogleShoppingSyncProviderResult> => ({
        status: "success",
        operation: "get-processed-product",
        attempts: 1,
        diagnostics: currentDiagnostics,
      }),
    ),
  };

  const outcome = await processGoogleShoppingDiagnosticsRow({
    db,
    row: diagnosticsRow({ diagnosticIssues: previousIssues }),
    mode: "live",
    merchantClient: client,
    jobContext: testJobContext(),
    previousIssueChunkSize,
  });

  return {
    outcome,
    persistedIssues: JSON.parse(String(db.queries.at(-1)?.values[3])) as GoogleShoppingDiagnosticIssueSnapshot[],
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

function diagnosticsSnapshotDb(): PgQueryable {
  return {
    query: async () => ({
      rows: [
        diagnosticsSnapshotRow({
          row_id: "google-shopping:listing:lst_1",
          listing_id: "lst_1",
          diagnostic_status: "disapproved",
          diagnostic_issues: [
            {
              code: "invalid_gtin",
              severity: "DISAPPROVED",
              resolution: "merchant_action",
              attribute: "gtins",
              reportingContext: "FREE_LISTINGS",
              description: "Invalid GTIN",
              detail: "Fix the GTIN.",
              documentation: "https://support.google.com/merchants/answer/6324461",
              applicableCountries: ["US"],
              firstSeenAt: now,
              lastSeenAt: now,
              resolvedAt: null,
              known: true,
            },
          ],
        }),
        diagnosticsSnapshotRow({
          row_id: "google-shopping:listing:lst_2",
          listing_id: "lst_2",
          diagnostic_status: "approved_with_issues",
          diagnostic_issues: [
            {
              code: "brand_new_policy_code",
              severity: "WARNING",
              resolution: "merchant_action",
              attribute: "image_link",
              reportingContext: "FREE_LISTINGS",
              description: "New provider warning",
              detail: "Review the warning.",
              documentation: null,
              applicableCountries: ["US"],
              firstSeenAt: now,
              lastSeenAt: now,
              resolvedAt: null,
              known: false,
            },
          ],
        }),
      ],
      rowCount: 2,
    }),
  };
}

function feedRowListDb(): PgQueryable & { queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("COUNT(*)::integer AS total_rows")) {
        return {
          rows: [
            {
              total_rows: 3,
              eligible_rows: 1,
              excluded_rows: 2,
              failed_rows: 1,
              disapproved_rows: 1,
              pending_delete_rows: 1,
              stale_rows: 1,
              nearing_refresh_rows: 1,
              pending_diagnostics_rows: 1,
            },
          ],
          rowCount: 1,
        };
      }

      return {
        rows: [feedRowListDbRow()],
        rowCount: 1,
      };
    },
  };
}

function feedRowListDbRow(overrides: Record<string, unknown> = {}) {
  return {
    row_id: "google-shopping:listing:lst_1",
    listing_id: "lst_1",
    account_id: "acc_1",
    catalog_catalog_item_id: "cit_1",
    product_id: "prd_1",
    merchant_offer_id: "cs-listing-lst_1",
    external_seller_id: "cs-account-acc_1",
    canonical_url: "https://marketplace.chasesets.com/listings/charizard-lst_1",
    target_country: "US",
    content_language: "en",
    feed_label: "US",
    payload_hash: "hash_2",
    eligibility_status: "excluded",
    exclusion_reasons: ["missing-title", "not-crawlable"],
    image_eligibility_status: "excluded",
    image_exclusion_reasons: ["missing-image"],
    shipping_policy_url: "https://chasesets.com/policies/shipping",
    return_policy_url: "https://chasesets.com/policies/returns",
    return_policy_label: "chase-sets-standard-returns",
    sync_status: "failed",
    last_submitted_payload_hash: "hash_1",
    last_submitted_at: "2026-05-01T12:00:00.000Z",
    last_accepted_at: "2026-05-01T12:00:00.000Z",
    last_sync_attempted_at: now,
    last_sync_error_code: "google_merchant_rate_limited",
    last_sync_error_message: "Merchant API rate limit exhausted.",
    last_provider_operation: "insert-product-input",
    diagnostic_status: "disapproved",
    diagnostic_issues: [
      {
        code: "brand_new_policy_code",
        severity: "DISAPPROVED",
        resolution: "merchant_action",
        attribute: "gtins",
        reportingContext: "FREE_LISTINGS",
        description: "Invalid GTIN",
        detail: "Fix the GTIN.",
        documentation: null,
        applicableCountries: ["US"],
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: null,
        known: false,
      },
    ],
    last_diagnostic_at: now,
    tombstone_status: "live",
    delete_submitted_at: null,
    updated_at: now,
    ...overrides,
  };
}

function diagnosticsSnapshotRow(overrides: Record<string, unknown>) {
  return {
    row_id: "google-shopping:listing:lst_1",
    listing_id: "lst_1",
    account_id: "acc_1",
    catalog_catalog_item_id: "cit_1",
    product_id: "prd_1",
    merchant_offer_id: "cs-listing-lst_1",
    external_seller_id: "cs-account-acc_1",
    diagnostic_status: "unknown",
    diagnostic_destination_statuses: [{ reportingContext: "FREE_LISTINGS" }],
    last_diagnostic_at: now,
    diagnostic_issues: [],
    ...overrides,
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

function diagnosticsSnapshot() {
  return {
    generatedAt: now,
    totals: {
      rows: 1,
      approved: 0,
      disapproved: 1,
      pending: 0,
      approvedWithIssues: 0,
      unknown: 0,
    },
    activeIssueSeverityCounts: { DISAPPROVED: 1 },
    unknownIssueCodeCount: 0,
    launchImpact: {
      p0: true,
      p1: false,
      reasons: ["1 submitted Google Shopping row(s) are disapproved."],
    },
    rows: [
      {
        rowId: "google-shopping:listing:lst_1",
        listingId: "lst_1",
        accountId: "acc_1",
        catalogItemId: "cit_1",
        productId: "prd_1",
        merchantOfferId: "cs-listing-lst_1",
        externalSellerId: "cs-account-acc_1",
        diagnosticStatus: "disapproved",
        destinationStatuses: [{ reportingContext: "FREE_LISTINGS" }],
        lastDiagnosticAt: now,
        issues: [
          {
            code: "invalid_gtin",
            severity: "DISAPPROVED",
            resolution: "merchant_action",
            attribute: "gtins",
            reportingContext: "FREE_LISTINGS",
            description: "Invalid GTIN",
            detail: "Fix the GTIN.",
            documentation: "https://support.google.com/merchants/answer/6324461",
            applicableCountries: ["US"],
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: null,
            known: true,
          },
        ],
      },
    ],
  };
}

function feedRowListResponse() {
  return {
    generatedAt: now,
    filter: "disapproved",
    search: "lst_1",
    limit: 25,
    refreshWindowDays: 20,
    refreshCutoff: "2026-05-14T12:00:00.000Z",
    summary: {
      totalRows: 1,
      eligibleRows: 1,
      excludedRows: 0,
      failedRows: 0,
      disapprovedRows: 1,
      pendingDeleteRows: 0,
      staleRows: 0,
      nearingRefreshRows: 0,
      pendingDiagnosticsRows: 0,
    },
    rows: [
      {
        rowId: "google-shopping:listing:lst_1",
        listingId: "lst_1",
        accountId: "acc_1",
        catalogItemId: "cit_1",
        productId: "prd_1",
        merchantOfferId: "cs-listing-lst_1",
        externalSellerId: "cs-account-acc_1",
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
        targetCountry: "US",
        contentLanguage: "en",
        feedLabel: "US",
        eligibilityStatus: "eligible",
        exclusionReasons: [],
        imageEligibilityStatus: "eligible",
        imageExclusionReasons: [],
        syncStatus: "submitted",
        diagnosticStatus: "disapproved",
        activeIssueCount: 1,
        unknownIssueCodeCount: 0,
        blockingIssueCount: 1,
        remediationOwners: ["Ops / Google Merchant Center"],
        pendingDelete: false,
        stale: false,
        nearingRefresh: false,
        payloadHash: "hash_1",
        lastSubmittedPayloadHash: "hash_1",
        lastSubmittedAt: now,
        lastAcceptedAt: now,
        lastSyncAttemptedAt: now,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
        lastProviderOperation: "get-processed-product",
        deleteSubmittedAt: null,
        lastDiagnosticAt: now,
        shippingPolicyUrl: "https://chasesets.com/policies/shipping",
        returnPolicyUrl: "https://chasesets.com/policies/returns",
        returnPolicyLabel: "chase-sets-standard-returns",
        updatedAt: now,
      },
    ],
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
