import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createInternalId } from "@chase-sets/primitives/typed-ids";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  isDurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import { t } from "@chase-sets/localization";
import type { GoogleShoppingPayloadInput } from "./export-row";
import {
  drainDueGoogleShoppingIncrementalSyncRequests,
  type GoogleShoppingIncrementalSyncReason,
  type GoogleShoppingIncrementalSyncRequest,
} from "./feed-row-projection";

export type GoogleShoppingSyncMode = "dry-run" | "live";

export type GoogleShoppingSyncProviderOperation =
  | "insert-product-input"
  | "patch-product-input"
  | "delete-product-input"
  | "get-processed-product";

export type GoogleShoppingProductIssue = Readonly<{
  code: string | null;
  severity: string | null;
  resolution: string | null;
  attribute: string | null;
  reportingContext: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  applicableCountries: readonly string[];
}>;

export type GoogleShoppingProductDiagnostics = Readonly<{
  productName: string;
  destinationStatuses: readonly unknown[];
  issues: readonly GoogleShoppingProductIssue[];
}>;

export type GoogleShoppingSyncProviderResult =
  | Readonly<{
      status: "success" | "dry-run";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      productInputName?: string | null;
      productName?: string | null;
      diagnostics?: GoogleShoppingProductDiagnostics;
    }>
  | Readonly<{
      status: "permanent-failure" | "transient-failure";
      operation: GoogleShoppingSyncProviderOperation;
      attempts: number;
      request?: unknown;
      error: Readonly<{
        code: string;
        message: string;
        httpStatus: number | null;
        retryable: boolean;
        providerRequestId: string | null;
        details?: unknown;
      }>;
    }>;

export type GoogleShoppingSyncMerchantClient = Readonly<{
  insertOrUpdateProductInput: (
    payload: GoogleShoppingPayloadInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  patchPriceAndAvailability?: (
    offerId: string,
    input: Readonly<{
      priceAmount: string;
      currencyCode: string;
      availability: GoogleShoppingPayloadInput["availability"];
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  deleteProductInput: (
    offerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
  getProcessedProductStatus?: (
    offerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<GoogleShoppingSyncProviderResult>;
}>;

export type GoogleShoppingFullSyncJobPayload = Readonly<{
  mode: GoogleShoppingSyncMode;
  batchSize: number;
  requestedByUserId: string | null;
  requestedForAccountId: string | null;
}>;

export type GoogleShoppingIncrementalSyncJobPayload = Readonly<{
  mode: GoogleShoppingSyncMode;
  batchSize: number;
  listingIds: readonly string[];
  reasonsByListingId: Readonly<Record<string, readonly GoogleShoppingIncrementalSyncReason[]>>;
  requestedByUserId: string | null;
  requestedForAccountId: string | null;
}>;

export type GoogleShoppingDiagnosticsRefreshJobPayload = Readonly<{
  mode: GoogleShoppingSyncMode;
  batchSize: number;
  requestedByUserId: string | null;
  requestedForAccountId: string | null;
}>;

export type GoogleShoppingMaintenanceAction = "refresh" | "cleanup";

export type GoogleShoppingMaintenanceCandidate = Readonly<{
  action: GoogleShoppingMaintenanceAction;
  rowId: string;
  listingId: string;
  merchantOfferId: string;
  eligibilityStatus: string;
  tombstoneStatus: string;
  syncStatus: string;
  payloadHash: string | null;
  lastSubmittedPayloadHash: string | null;
  lastSubmittedAt: string | null;
  lastAcceptedAt: string | null;
  deleteSubmittedAt: string | null;
}>;

export type GoogleShoppingMaintenancePreview = Readonly<{
  mode: GoogleShoppingSyncMode;
  refreshWindowDays: number;
  refreshCutoff: string;
  limit: number;
  retentionDays: number;
  refresh: readonly GoogleShoppingMaintenanceCandidate[];
  cleanup: readonly GoogleShoppingMaintenanceCandidate[];
  total: number;
}>;

export type GoogleShoppingFeedRowFilter =
  | "all"
  | "eligible"
  | "excluded"
  | "failed"
  | "disapproved"
  | "pending-delete"
  | "nearing-refresh"
  | "stale"
  | "pending-diagnostics";

export type GoogleShoppingFeedRowListItem = Readonly<{
  rowId: string;
  listingId: string;
  accountId: string;
  catalogItemId: string;
  productId: string;
  merchantOfferId: string;
  externalSellerId: string;
  canonicalUrl: string;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
  eligibilityStatus: string;
  exclusionReasons: readonly string[];
  imageEligibilityStatus: string;
  imageExclusionReasons: readonly string[];
  syncStatus: string;
  diagnosticStatus: GoogleShoppingDiagnosticStatus | null;
  activeIssueCount: number;
  unknownIssueCodeCount: number;
  blockingIssueCount: number;
  remediationOwners: readonly string[];
  pendingDelete: boolean;
  stale: boolean;
  nearingRefresh: boolean;
  payloadHash: string | null;
  lastSubmittedPayloadHash: string | null;
  lastSubmittedAt: string | null;
  lastAcceptedAt: string | null;
  lastSyncAttemptedAt: string | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorMessage: string | null;
  lastProviderOperation: string | null;
  deleteSubmittedAt: string | null;
  lastDiagnosticAt: string | null;
  shippingPolicyUrl: string | null;
  returnPolicyUrl: string | null;
  returnPolicyLabel: string | null;
  updatedAt: string;
}>;

export type GoogleShoppingFeedRowList = Readonly<{
  generatedAt: string;
  filter: GoogleShoppingFeedRowFilter;
  search: string;
  limit: number;
  refreshWindowDays: number;
  refreshCutoff: string;
  summary: Readonly<{
    totalRows: number;
    eligibleRows: number;
    excludedRows: number;
    failedRows: number;
    disapprovedRows: number;
    pendingDeleteRows: number;
    staleRows: number;
    nearingRefreshRows: number;
    pendingDiagnosticsRows: number;
  }>;
  rows: readonly GoogleShoppingFeedRowListItem[];
}>;

export type GoogleShoppingMaintenanceEnqueueResult = Readonly<{
  summary: GoogleShoppingMaintenancePreview;
  job: GoogleShoppingFullSyncJob | null;
}>;

export type GoogleShoppingDiagnosticIssueSnapshot = Readonly<{
  code: string;
  severity: string;
  resolution: string | null;
  attribute: string | null;
  reportingContext: string | null;
  description: string | null;
  detail: string | null;
  documentation: string | null;
  applicableCountries: readonly string[];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  known: boolean;
}>;

export type GoogleShoppingDiagnosticStatus =
  | "approved"
  | "approved_with_issues"
  | "disapproved"
  | "pending"
  | "unknown";

export type GoogleShoppingDiagnosticsSnapshotRow = Readonly<{
  rowId: string;
  listingId: string;
  accountId: string;
  catalogItemId: string;
  productId: string;
  merchantOfferId: string;
  externalSellerId: string;
  diagnosticStatus: GoogleShoppingDiagnosticStatus | null;
  destinationStatuses: readonly unknown[];
  lastDiagnosticAt: string | null;
  issues: readonly GoogleShoppingDiagnosticIssueSnapshot[];
}>;

export type GoogleShoppingDiagnosticsSnapshot = Readonly<{
  generatedAt: string;
  totals: Readonly<{
    rows: number;
    approved: number;
    disapproved: number;
    pending: number;
    approvedWithIssues: number;
    unknown: number;
  }>;
  activeIssueSeverityCounts: Readonly<Record<string, number>>;
  unknownIssueCodeCount: number;
  launchImpact: Readonly<{
    p0: boolean;
    p1: boolean;
    reasons: readonly string[];
  }>;
  rows: readonly GoogleShoppingDiagnosticsSnapshotRow[];
}>;

export type GoogleShoppingDiagnosticsRefreshResult = Readonly<{
  mode: GoogleShoppingSyncMode;
  checked: number;
  approved: number;
  disapproved: number;
  pending: number;
  approvedWithIssues: number;
  failed: number;
  unknownIssueCodes: number;
  resolvedIssues: number;
  total: number;
}>;

export type GoogleShoppingDiagnosticsNormalizationOptions = Readonly<{
  previousIssueChunkSize?: number;
}>;

export type GoogleShoppingFullSyncJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentRowId: string | null;
  submitted: number;
  skipped: number;
  deleted: number;
  failed: number;
  excluded: number;
  message: string | null;
}>;

export type GoogleShoppingFullSyncJobResult = Readonly<{
  mode: GoogleShoppingSyncMode;
  submitted: number;
  skipped: number;
  deleted: number;
  failed: number;
  excluded: number;
  total: number;
  diagnostics?: GoogleShoppingDiagnosticsRefreshResult;
}>;

export type GoogleShoppingFullSyncJob = DurableJobRecord<
  GoogleShoppingFullSyncJobPayload,
  GoogleShoppingFullSyncJobProgress,
  GoogleShoppingFullSyncJobResult
>;

export type GoogleShoppingFullSyncJobStatus = DurableJobPublicSnapshot<
  GoogleShoppingFullSyncJobProgress,
  GoogleShoppingFullSyncJobResult
>;

type GoogleShoppingSyncJobPayload =
  | GoogleShoppingFullSyncJobPayload
  | GoogleShoppingIncrementalSyncJobPayload
  | GoogleShoppingDiagnosticsRefreshJobPayload;

type GoogleShoppingSyncJobStore = ReturnType<
  typeof createPostgresDurableJobStore<
    GoogleShoppingSyncJobPayload,
    GoogleShoppingFullSyncJobProgress,
    GoogleShoppingFullSyncJobResult
  >
>;

export type GoogleShoppingFeedRowForSync = Readonly<{
  rowId: string;
  listingId: string;
  merchantOfferId: string;
  payload: GoogleShoppingPayloadInput | null;
  payloadHash: string | null;
  eligibilityStatus: string;
  exclusionReasons: unknown;
  syncStatus: string;
  lastSubmittedPayloadHash: string | null;
  tombstoneStatus: string;
  deleteSubmittedAt: string | null;
}>;

type GoogleShoppingFeedRowForDiagnostics = Readonly<{
  rowId: string;
  listingId: string;
  accountId: string;
  catalogItemId: string;
  productId: string;
  merchantOfferId: string;
  externalSellerId: string;
  diagnosticIssues: unknown;
}>;

type GoogleShoppingDiagnosticsRowOutcome = Readonly<{
  outcome: "checked" | "failed" | "skipped";
  status: GoogleShoppingDiagnosticStatus;
  activeIssues: number;
  unknownIssueCodes: number;
  resolvedIssues: number;
}>;

type GoogleShoppingMaintenanceCandidateRow = Readonly<{
  action: GoogleShoppingMaintenanceAction;
  row_id: string;
  listing_id: string;
  merchant_offer_id: string;
  eligibility_status: string;
  tombstone_status: string;
  sync_status: string;
  payload_hash: string | null;
  last_submitted_payload_hash: string | null;
  last_submitted_at: Date | string | null;
  last_accepted_at: Date | string | null;
  delete_submitted_at: Date | string | null;
}>;

type GoogleShoppingFeedRowListDbRow = Readonly<{
  row_id: string;
  listing_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  merchant_offer_id: string;
  external_seller_id: string;
  canonical_url: string;
  target_country: string;
  content_language: string;
  feed_label: string;
  payload_hash: string | null;
  eligibility_status: string;
  exclusion_reasons: unknown;
  image_eligibility_status: string;
  image_exclusion_reasons: unknown;
  shipping_policy_url: string | null;
  return_policy_url: string | null;
  return_policy_label: string | null;
  sync_status: string;
  last_submitted_payload_hash: string | null;
  last_submitted_at: Date | string | null;
  last_accepted_at: Date | string | null;
  last_sync_attempted_at: Date | string | null;
  last_sync_error_code: string | null;
  last_sync_error_message: string | null;
  last_provider_operation: string | null;
  diagnostic_status: string | null;
  diagnostic_issues: unknown;
  last_diagnostic_at: Date | string | null;
  tombstone_status: string;
  delete_submitted_at: Date | string | null;
  updated_at: Date | string;
}>;

type GoogleShoppingFeedRowSummaryDbRow = Readonly<{
  total_rows: number | string;
  eligible_rows: number | string;
  excluded_rows: number | string;
  failed_rows: number | string;
  disapproved_rows: number | string;
  pending_delete_rows: number | string;
  stale_rows: number | string;
  nearing_refresh_rows: number | string;
  pending_diagnostics_rows: number | string;
}>;

type GoogleShoppingSyncRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

const FULL_SYNC_JOB_KIND = "full-sync";
const INCREMENTAL_SYNC_JOB_KIND = "incremental-sync";
const DIAGNOSTICS_REFRESH_JOB_KIND = "diagnostics-refresh";
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const DEFAULT_INCREMENTAL_BATCH_SIZE = 100;
const DEFAULT_MAINTENANCE_BATCH_SIZE = 100;
const DEFAULT_DIAGNOSTICS_BATCH_SIZE = 100;
const DEFAULT_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE = 100;
const DEFAULT_REFRESH_WINDOW_DAYS = 25;
const GOOGLE_SHOPPING_SYNC_STATE_RETENTION_DAYS = 90;

const GOOGLE_SHOPPING_SYSTEM_CONTEXT: EventStoreContext = {
  tenantId: "tnt_discovery" as TenantId,
  audit: {
    performedByUserId: "usr_discovery_google_shopping_system" as UserId,
    forAccountId: "acc_discovery_google_shopping_system" as AccountId,
  },
};

export type GoogleShoppingSyncServices = Readonly<{
  enqueueFullSyncJob: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; batchSize?: number }>,
    context: EventStoreContext,
  ) => Promise<GoogleShoppingFullSyncJob>;
  previewMaintenanceSync: (
    params?: Readonly<{
      mode?: GoogleShoppingSyncMode;
      refreshWindowDays?: number;
      limit?: number;
      now?: string | Date;
    }>,
  ) => Promise<GoogleShoppingMaintenancePreview>;
  enqueueMaintenanceSyncJob: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; refreshWindowDays?: number; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<GoogleShoppingMaintenanceEnqueueResult>;
  enqueueDiagnosticsRefreshJob: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; batchSize?: number }>,
    context: EventStoreContext,
  ) => Promise<GoogleShoppingFullSyncJob>;
  listFeedRows: (input?: {
    filter?: GoogleShoppingFeedRowFilter;
    search?: string;
    limit?: number;
    refreshWindowDays?: number;
    now?: string | Date;
  }) => Promise<GoogleShoppingFeedRowList>;
  getDiagnosticsSnapshot: (input?: { limit?: number }) => Promise<GoogleShoppingDiagnosticsSnapshot>;
  processScheduledMaintenanceSync: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; refreshWindowDays?: number; limit?: number }>,
  ) => Promise<number>;
  processScheduledDiagnosticsRefresh: (
    params: Readonly<{ mode: GoogleShoppingSyncMode; batchSize?: number }>,
  ) => Promise<number>;
  getFullSyncJob: (jobId: string) => Promise<GoogleShoppingFullSyncJob | null>;
  listFullSyncJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<
    readonly DurableJobEvent<
      GoogleShoppingFullSyncJobPayload,
      GoogleShoppingFullSyncJobProgress,
      GoogleShoppingFullSyncJobResult
    >[]
  >;
  waitForFullSyncJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneFullSyncJobRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNextFullSyncJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    merchantClientForMode: (mode: GoogleShoppingSyncMode) => GoogleShoppingSyncMerchantClient;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  processNextIncrementalSyncJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    mode: GoogleShoppingSyncMode;
    batchSize?: number;
    merchantClientForMode: (mode: GoogleShoppingSyncMode) => GoogleShoppingSyncMerchantClient;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  processNextDiagnosticsRefreshJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    previousIssueChunkSize?: number;
    merchantClientForMode: (mode: GoogleShoppingSyncMode) => GoogleShoppingSyncMerchantClient;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
}>;

export function createGoogleShoppingSyncRuntime(deps: GoogleShoppingSyncRuntimeDeps): GoogleShoppingSyncServices {
  const jobStore = createPostgresDurableJobStore<
    GoogleShoppingSyncJobPayload,
    GoogleShoppingFullSyncJobProgress,
    GoogleShoppingFullSyncJobResult
  >(deps.db, {
    jobsTable: "discovery_google_shopping_sync_jobs",
    eventsTable: "discovery_google_shopping_sync_job_events",
    notifyChannel: "discovery_google_shopping_sync_job_events",
  });

  return {
    enqueueFullSyncJob: async (params, context) => {
      const total = await countGoogleShoppingFeedRows(deps.db);
      return (await jobStore.enqueue({
        jobId: createJobId(),
        jobKind: FULL_SYNC_JOB_KIND,
        payload: {
          mode: params.mode,
          batchSize: normalizeBatchSize(params.batchSize),
          requestedByUserId: context.audit.performedByUserId,
          requestedForAccountId: context.audit.forAccountId,
        },
        progress: googleShoppingSyncProgress({
          phase: "queued",
          completed: 0,
          total,
          currentRowId: null,
          message: t("discovery.googleShoppingOperations.sync.fullQueued"),
        }),
        eventContext: context,
      })) as GoogleShoppingFullSyncJob;
    },
    previewMaintenanceSync: async (params = {}) =>
      previewGoogleShoppingMaintenanceSync(deps.db, {
        mode: params.mode ?? "dry-run",
        refreshWindowDays: params.refreshWindowDays,
        limit: params.limit,
        now: params.now,
      }),
    enqueueMaintenanceSyncJob: async (params, context) => {
      const summary = await previewGoogleShoppingMaintenanceSync(deps.db, {
        mode: params.mode,
        refreshWindowDays: params.refreshWindowDays,
        limit: params.limit,
      });
      if (summary.total === 0) {
        return { summary, job: null };
      }

      const job = await enqueueIncrementalSyncJob(jobStore, {
        mode: params.mode,
        requests: googleShoppingMaintenanceRequests(summary),
        context,
        message: t("discovery.googleShoppingOperations.sync.maintenanceQueued"),
      });
      return { summary, job };
    },
    enqueueDiagnosticsRefreshJob: async (params, context) => {
      const total = await countGoogleShoppingDiagnosticsCandidates(deps.db);
      return (await jobStore.enqueue({
        jobId: createJobId(),
        jobKind: DIAGNOSTICS_REFRESH_JOB_KIND,
        payload: {
          mode: params.mode,
          batchSize: normalizeBatchSize(params.batchSize ?? DEFAULT_DIAGNOSTICS_BATCH_SIZE),
          requestedByUserId: context.audit.performedByUserId,
          requestedForAccountId: context.audit.forAccountId,
        },
        progress: googleShoppingSyncProgress({
          phase: "queued",
          completed: 0,
          total,
          currentRowId: null,
          message: t("discovery.googleShoppingOperations.sync.diagnosticsQueued"),
        }),
        eventContext: context,
      })) as GoogleShoppingFullSyncJob;
    },
    getDiagnosticsSnapshot: (input = {}) =>
      getGoogleShoppingDiagnosticsSnapshot(deps.db, {
        limit: normalizeBatchSize(input.limit ?? DEFAULT_DIAGNOSTICS_BATCH_SIZE),
      }),
    listFeedRows: (input = {}) => listGoogleShoppingFeedRows(deps.db, input),
    getFullSyncJob: async (jobId) => (await jobStore.get(jobId)) as GoogleShoppingFullSyncJob | null,
    listFullSyncJobEvents: async (jobId, afterSequence = 0) =>
      (await jobStore.listEvents(jobId, afterSequence)) as readonly DurableJobEvent<
        GoogleShoppingFullSyncJobPayload,
        GoogleShoppingFullSyncJobProgress,
        GoogleShoppingFullSyncJobResult
      >[],
    waitForFullSyncJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    pruneFullSyncJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? retentionCutoff(7),
        limit: input.limit,
      }),
    processScheduledMaintenanceSync: async (params) => {
      const summary = await previewGoogleShoppingMaintenanceSync(deps.db, {
        mode: params.mode,
        refreshWindowDays: params.refreshWindowDays,
        limit: params.limit,
      });
      if (summary.total === 0) {
        return 0;
      }

      await enqueueIncrementalSyncJob(jobStore, {
        mode: params.mode,
        requests: googleShoppingMaintenanceRequests(summary),
        context: GOOGLE_SHOPPING_SYSTEM_CONTEXT,
        message: t("discovery.googleShoppingOperations.sync.scheduledMaintenanceQueued"),
      });
      return 1;
    },
    processScheduledDiagnosticsRefresh: async (params) => {
      const total = await countGoogleShoppingDiagnosticsCandidates(deps.db);
      if (total === 0) {
        return 0;
      }

      await jobStore.enqueue({
        jobId: createJobId(),
        jobKind: DIAGNOSTICS_REFRESH_JOB_KIND,
        payload: {
          mode: params.mode,
          batchSize: normalizeBatchSize(params.batchSize ?? DEFAULT_DIAGNOSTICS_BATCH_SIZE),
          requestedByUserId: GOOGLE_SHOPPING_SYSTEM_CONTEXT.audit.performedByUserId,
          requestedForAccountId: GOOGLE_SHOPPING_SYSTEM_CONTEXT.audit.forAccountId,
        },
        progress: googleShoppingSyncProgress({
          phase: "queued",
          completed: 0,
          total,
          currentRowId: null,
          message: t("discovery.googleShoppingOperations.sync.scheduledDiagnosticsQueued"),
        }),
        eventContext: GOOGLE_SHOPPING_SYSTEM_CONTEXT,
      });
      return 1;
    },
    processNextFullSyncJob: async (input) => {
      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [FULL_SYNC_JOB_KIND],
      });
      if (!claimed) {
        return 0;
      }

      try {
        throwIfGoogleShoppingSyncCancelled(input);
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Google Shopping full sync job was cancelled.",
          claimLostMessage: "Google Shopping full sync job claim was lost before the status update completed.",
        });
        const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
          minIntervalMs: 1_000,
          minCompletedDelta: Math.max(1, Math.floor(claimed.payload.batchSize / 2)),
          minRenewIntervalMs: 5_000,
          completed: (progress) => progress.completed,
          isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
        });
        const total = await countGoogleShoppingFeedRows(deps.db);
        let progress = googleShoppingSyncProgress({
          ...claimed.progress,
          phase: "processing",
          total,
          message: t("discovery.googleShoppingOperations.sync.fullProcessing"),
        });
        await requireGoogleShoppingSyncClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress,
          }),
        );

        const merchantClient = input.merchantClientForMode(claimed.payload.mode);
        let cursor: string | null = null;

        for (;;) {
          throwIfGoogleShoppingSyncCancelled(input);
          const rows = await listGoogleShoppingFeedRowsAfter(deps.db, {
            afterRowId: cursor,
            limit: claimed.payload.batchSize,
          });
          if (rows.length === 0) {
            break;
          }

          for (const row of rows) {
            throwIfGoogleShoppingSyncCancelled(input);
            const outcome = await processGoogleShoppingSyncRow({
              db: deps.db,
              row,
              mode: claimed.payload.mode,
              merchantClient,
              signal: input.signal,
              jobContext,
            });
            progress = addGoogleShoppingSyncOutcome(progress, row.rowId, outcome);
            await progressCheckpoint.checkpoint(progress, toGoogleShoppingSyncResult(claimed.payload.mode, progress));
          }

          cursor = rows[rows.length - 1]?.rowId ?? cursor;
        }

        const finalProgress = googleShoppingSyncProgress({
          ...progress,
          phase: "completed",
          completed: progress.completed,
          total: Math.max(progress.total, progress.completed),
          message: t("discovery.googleShoppingOperations.sync.fullCompleted"),
        });
        const result = toGoogleShoppingSyncResult(claimed.payload.mode, finalProgress);
        await requireGoogleShoppingSyncClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: finalProgress,
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isDurableJobHandoffError(error, input)) {
          return 0;
        }
        await requireGoogleShoppingSyncClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Google Shopping full sync job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Google Shopping full sync job failed.",
          }),
        );
        return 1;
      }
    },
    processNextIncrementalSyncJob: async (input) => {
      let claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [INCREMENTAL_SYNC_JOB_KIND],
      });

      if (!claimed) {
        const requests = await drainDueGoogleShoppingIncrementalSyncRequests(deps.db, {
          limit: normalizeBatchSize(input.batchSize ?? DEFAULT_INCREMENTAL_BATCH_SIZE),
        });
        if (requests.length === 0) {
          return 0;
        }

        await enqueueIncrementalSyncJob(jobStore, {
          mode: input.mode,
          requests,
        });
        claimed = await jobStore.claimNext({
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          jobKinds: [INCREMENTAL_SYNC_JOB_KIND],
        });
      }

      if (!claimed) {
        return 0;
      }

      try {
        throwIfGoogleShoppingSyncCancelled(input);
        const payload = claimed.payload as GoogleShoppingIncrementalSyncJobPayload;
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Google Shopping incremental sync job was cancelled.",
          claimLostMessage: "Google Shopping incremental sync job claim was lost before the status update completed.",
        });
        const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
          minIntervalMs: 1_000,
          minCompletedDelta: Math.max(1, Math.floor(payload.batchSize / 2)),
          minRenewIntervalMs: 5_000,
          completed: (progress) => progress.completed,
          isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
        });
        let progress = googleShoppingSyncProgress({
          ...claimed.progress,
          phase: "processing",
          total: payload.listingIds.length,
          message: t("discovery.googleShoppingOperations.sync.incrementalProcessing"),
        });
        await requireGoogleShoppingSyncClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress,
          }),
        );

        const rows = await listGoogleShoppingFeedRowsByListingIds(deps.db, payload.listingIds);
        // Bounded by the incremental job payload, which is created from a configured maintenance/due-request chunk.
        const rowsByListingId = new Map(rows.map((row) => [row.listingId, row]));
        const merchantClient = input.merchantClientForMode(payload.mode);

        for (const listingId of payload.listingIds) {
          throwIfGoogleShoppingSyncCancelled(input);
          const row = rowsByListingId.get(listingId);
          const reasons = payload.reasonsByListingId[listingId] ?? [];
          if (!row) {
            progress = addGoogleShoppingSyncOutcome(progress, listingId, "excluded");
            await progressCheckpoint.checkpoint(progress, toGoogleShoppingSyncResult(payload.mode, progress));
            continue;
          }

          const outcome = await processGoogleShoppingSyncRow({
            db: deps.db,
            row,
            mode: payload.mode,
            merchantClient,
            signal: input.signal,
            jobContext,
            forceSubmit: shouldForceScheduledRefresh(reasons),
            preferredOperation: shouldPatchPriceAndAvailability(reasons) ? "patch-price-availability" : "full",
          });
          progress = addGoogleShoppingSyncOutcome(progress, row.rowId, outcome);
          await progressCheckpoint.checkpoint(progress, toGoogleShoppingSyncResult(payload.mode, progress));
        }

        const finalProgress = googleShoppingSyncProgress({
          ...progress,
          phase: "completed",
          completed: progress.completed,
          total: Math.max(progress.total, progress.completed),
          message: t("discovery.googleShoppingOperations.sync.incrementalCompleted"),
        });
        const result = toGoogleShoppingSyncResult(payload.mode, finalProgress);
        await requireGoogleShoppingSyncClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: finalProgress,
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isDurableJobHandoffError(error, input)) {
          return 0;
        }
        await requireGoogleShoppingSyncClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Google Shopping incremental sync job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Google Shopping incremental sync job failed.",
          }),
        );
        return 1;
      }
    },
    processNextDiagnosticsRefreshJob: async (input) => {
      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [DIAGNOSTICS_REFRESH_JOB_KIND],
      });
      if (!claimed) {
        return 0;
      }

      try {
        throwIfGoogleShoppingSyncCancelled(input);
        const payload = claimed.payload as GoogleShoppingDiagnosticsRefreshJobPayload;
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Google Shopping diagnostics refresh job was cancelled.",
          claimLostMessage:
            "Google Shopping diagnostics refresh job claim was lost before the status update completed.",
        });
        const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
          minIntervalMs: 1_000,
          minCompletedDelta: Math.max(1, Math.floor(payload.batchSize / 2)),
          minRenewIntervalMs: 5_000,
          completed: (progress) => progress.completed,
          isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
        });
        const total = await countGoogleShoppingDiagnosticsCandidates(deps.db);
        let progress = googleShoppingSyncProgress({
          ...claimed.progress,
          phase: "processing",
          total,
          message: t("discovery.googleShoppingOperations.sync.diagnosticsProcessing"),
        });
        await requireGoogleShoppingSyncClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress,
          }),
        );

        const merchantClient = input.merchantClientForMode(payload.mode);
        const previousIssueChunkSize = normalizeBatchSize(
          input.previousIssueChunkSize ?? DEFAULT_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE,
        );
        let cursor: string | null = null;
        let diagnosticsResult = emptyGoogleShoppingDiagnosticsRefreshResult(payload.mode, total);

        for (;;) {
          throwIfGoogleShoppingSyncCancelled(input);
          const rows = await listGoogleShoppingDiagnosticsRowsAfter(deps.db, {
            afterRowId: cursor,
            limit: payload.batchSize,
          });
          if (rows.length === 0) {
            break;
          }

          for (const row of rows) {
            throwIfGoogleShoppingSyncCancelled(input);
            const outcome = await processGoogleShoppingDiagnosticsRow({
              db: deps.db,
              row,
              mode: payload.mode,
              merchantClient,
              signal: input.signal,
              jobContext,
              previousIssueChunkSize,
            });
            diagnosticsResult = addGoogleShoppingDiagnosticsOutcome(diagnosticsResult, outcome);
            progress = addGoogleShoppingSyncOutcome(
              progress,
              row.rowId,
              outcome.outcome === "failed" ? "failed" : outcome.status === "disapproved" ? "excluded" : "submitted",
            );
            await progressCheckpoint.checkpoint(progress, {
              ...toGoogleShoppingSyncResult(payload.mode, progress),
              diagnostics: diagnosticsResult,
            });
          }

          cursor = rows[rows.length - 1]?.rowId ?? cursor;
        }

        const finalProgress = googleShoppingSyncProgress({
          ...progress,
          phase: "completed",
          completed: progress.completed,
          total: Math.max(progress.total, progress.completed),
          message: t("discovery.googleShoppingOperations.sync.diagnosticsCompleted"),
        });
        const result = {
          ...toGoogleShoppingSyncResult(payload.mode, finalProgress),
          diagnostics: diagnosticsResult,
        };
        await requireGoogleShoppingSyncClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: finalProgress,
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isDurableJobHandoffError(error, input)) {
          return 0;
        }
        await requireGoogleShoppingSyncClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Google Shopping diagnostics refresh job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Google Shopping diagnostics refresh job failed.",
          }),
        );
        return 1;
      }
    },
  };
}

export function toGoogleShoppingFullSyncJobStatus(job: GoogleShoppingFullSyncJob): GoogleShoppingFullSyncJobStatus {
  return toDurableJobPublicSnapshot(job);
}

export async function previewGoogleShoppingMaintenanceSync(
  db: PgQueryable,
  input: Readonly<{
    mode?: GoogleShoppingSyncMode;
    refreshWindowDays?: number;
    limit?: number;
    now?: string | Date;
  }> = {},
): Promise<GoogleShoppingMaintenancePreview> {
  const refreshWindowDays = normalizePositiveInteger(input.refreshWindowDays, DEFAULT_REFRESH_WINDOW_DAYS);
  const limit = normalizeBatchSize(input.limit ?? DEFAULT_MAINTENANCE_BATCH_SIZE);
  const refreshCutoff = refreshCutoffFor(input.now, refreshWindowDays).toISOString();
  const candidates = await listGoogleShoppingMaintenanceCandidates(db, { refreshCutoff, limit });
  const refresh = candidates.filter((candidate) => candidate.action === "refresh");
  const cleanup = candidates.filter((candidate) => candidate.action === "cleanup");

  return {
    mode: input.mode ?? "dry-run",
    refreshWindowDays,
    refreshCutoff,
    limit,
    retentionDays: GOOGLE_SHOPPING_SYNC_STATE_RETENTION_DAYS,
    refresh,
    cleanup,
    total: candidates.length,
  };
}

export async function listGoogleShoppingMaintenanceCandidates(
  db: PgQueryable,
  input: Readonly<{ refreshCutoff: string; limit: number }>,
): Promise<GoogleShoppingMaintenanceCandidate[]> {
  const limit = normalizeBatchSize(input.limit);
  const cleanup = await listGoogleShoppingCleanupCandidates(db, limit);
  const remaining = Math.max(0, limit - cleanup.length);
  const refresh = remaining > 0 ? await listGoogleShoppingRefreshCandidates(db, { ...input, limit: remaining }) : [];

  return [...cleanup, ...refresh];
}

async function enqueueIncrementalSyncJob(
  jobStore: GoogleShoppingSyncJobStore,
  input: Readonly<{
    mode: GoogleShoppingSyncMode;
    requests: readonly GoogleShoppingIncrementalSyncRequest[];
    context?: EventStoreContext;
    message?: string;
  }>,
): Promise<GoogleShoppingFullSyncJob> {
  // Key-only de-dupe bounded by the request chunk supplied by scheduled maintenance or due-request draining.
  const listingIds = [...new Set(input.requests.map((request) => request.listingId))];
  const reasonsByListingId = Object.fromEntries(
    listingIds.map((listingId) => [
      listingId,
      [
        // Key-only reason de-dupe is per listing within the same bounded request chunk.
        ...new Set(
          input.requests.filter((request) => request.listingId === listingId).flatMap((request) => request.reasons),
        ),
      ],
    ]),
  );
  const context = input.context ?? GOOGLE_SHOPPING_SYSTEM_CONTEXT;

  return (await jobStore.enqueue({
    jobId: createJobId(),
    jobKind: INCREMENTAL_SYNC_JOB_KIND,
    payload: {
      mode: input.mode,
      batchSize: listingIds.length,
      listingIds,
      reasonsByListingId,
      requestedByUserId: context.audit.performedByUserId,
      requestedForAccountId: context.audit.forAccountId,
    },
    progress: googleShoppingSyncProgress({
      phase: "queued",
      completed: 0,
      total: listingIds.length,
      currentRowId: null,
      message: input.message ?? "Google Shopping incremental sync queued.",
    }),
    eventContext: context,
  })) as GoogleShoppingFullSyncJob;
}

function googleShoppingMaintenanceRequests(
  summary: GoogleShoppingMaintenancePreview,
): readonly GoogleShoppingIncrementalSyncRequest[] {
  return [
    ...summary.cleanup.map((candidate) => ({
      listingId: candidate.listingId,
      reasons: ["stale-cleanup" as const],
    })),
    ...summary.refresh.map((candidate) => ({
      listingId: candidate.listingId,
      reasons: ["scheduled-refresh" as const],
    })),
  ];
}

export function classifyGoogleShoppingSyncRow(
  row: GoogleShoppingFeedRowForSync,
):
  | Readonly<{ action: "submit"; reason: "changed" | "resubmit-after-delete" | "scheduled-refresh" }>
  | Readonly<{ action: "delete"; reason: "tombstone" | "no-longer-eligible" }>
  | Readonly<{ action: "skip"; reason: "unchanged" }>
  | Readonly<{ action: "exclude"; reason: "not-eligible" | "tombstone-never-submitted" }>
  | Readonly<{ action: "fail"; reason: "missing-payload" }> {
  const wasSubmitted = Boolean(row.lastSubmittedPayloadHash);
  const deleteAlreadySubmitted = Boolean(row.deleteSubmittedAt);
  const isTombstone = row.tombstoneStatus !== "live";
  const isEligible = row.eligibilityStatus === "eligible";

  if (isTombstone) {
    if (wasSubmitted && !deleteAlreadySubmitted) {
      return { action: "delete", reason: "tombstone" };
    }
    return { action: "exclude", reason: "tombstone-never-submitted" };
  }

  if (!isEligible) {
    if (wasSubmitted && !deleteAlreadySubmitted) {
      return { action: "delete", reason: "no-longer-eligible" };
    }
    return { action: "exclude", reason: "not-eligible" };
  }

  if (!row.payload || !row.payloadHash) {
    return { action: "fail", reason: "missing-payload" };
  }

  if (!deleteAlreadySubmitted && row.lastSubmittedPayloadHash && row.payloadHash === row.lastSubmittedPayloadHash) {
    return { action: "skip", reason: "unchanged" };
  }

  return { action: "submit", reason: deleteAlreadySubmitted ? "resubmit-after-delete" : "changed" };
}

export async function processGoogleShoppingSyncRow(input: {
  db: PgQueryable;
  row: GoogleShoppingFeedRowForSync;
  mode: GoogleShoppingSyncMode;
  merchantClient: GoogleShoppingSyncMerchantClient;
  signal?: AbortSignal;
  jobContext: DurableJobExecutionContext<GoogleShoppingFullSyncJobProgress, GoogleShoppingFullSyncJobResult>;
  preferredOperation?: "full" | "patch-price-availability";
  forceSubmit?: boolean;
}): Promise<"submitted" | "skipped" | "deleted" | "failed" | "excluded"> {
  let classification = classifyGoogleShoppingSyncRow(input.row);
  const attemptedAt = new Date().toISOString();

  if (classification.action === "skip" && input.forceSubmit) {
    classification = { action: "submit", reason: "scheduled-refresh" };
  }

  if (classification.action === "skip") {
    return "skipped";
  }
  if (classification.action === "exclude") {
    return "excluded";
  }
  if (classification.action === "fail") {
    if (input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: "insert-product-input",
        code: "google_shopping_missing_payload",
        message: t("discovery.googleShoppingOperations.sync.rowMissingPayload"),
        response: { classification },
        providerRequestId: null,
      });
    }
    return "failed";
  }

  try {
    const result =
      classification.action === "submit"
        ? await runGoogleShoppingSyncSideEffect(input.jobContext, (signal) =>
            shouldPatchGoogleShoppingRow(input)
              ? input.merchantClient.patchPriceAndAvailability!(
                  input.row.merchantOfferId,
                  {
                    priceAmount: input.row.payload!.priceAmount,
                    currencyCode: input.row.payload!.currencyCode,
                    availability: input.row.payload!.availability,
                  },
                  { signal },
                )
              : input.merchantClient.insertOrUpdateProductInput(input.row.payload!, { signal }),
          )
        : await runGoogleShoppingSyncSideEffect(input.jobContext, (signal) =>
            input.merchantClient.deleteProductInput(input.row.merchantOfferId, { signal }),
          );

    if (result.status === "success" || result.status === "dry-run") {
      if (input.mode === "live") {
        if (classification.action === "submit") {
          await recordGoogleShoppingRowSubmitted(input.db, input.row, { attemptedAt, result });
        } else {
          await recordGoogleShoppingRowDeleted(input.db, input.row.rowId, { attemptedAt, result });
        }
      }
      return classification.action === "submit" ? "submitted" : "deleted";
    }

    if (isGoogleShoppingSyncProviderFailure(result) && input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: result.operation,
        code: result.error.code,
        message: result.error.message,
        response: result,
        providerRequestId: result.error.providerRequestId,
      });
    }
    return "failed";
  } catch (error) {
    if (isDurableJobHandoffError(error, { signal: input.signal })) {
      throw error;
    }
    if (input.mode === "live") {
      await recordGoogleShoppingRowFailure(input.db, input.row.rowId, {
        attemptedAt,
        operation: classification.action === "submit" ? "insert-product-input" : "delete-product-input",
        code: "google_shopping_sync_exception",
        message: error instanceof Error ? error.message : "Google Shopping sync row failed.",
        response: { error: error instanceof Error ? error.message : String(error) },
        providerRequestId: null,
      });
    }
    return "failed";
  }
}

function shouldPatchGoogleShoppingRow(input: {
  row: GoogleShoppingFeedRowForSync;
  merchantClient: GoogleShoppingSyncMerchantClient;
  preferredOperation?: "full" | "patch-price-availability";
}) {
  return (
    input.preferredOperation === "patch-price-availability" &&
    Boolean(input.merchantClient.patchPriceAndAvailability) &&
    Boolean(input.row.payload) &&
    Boolean(input.row.lastSubmittedPayloadHash) &&
    !input.row.deleteSubmittedAt
  );
}

async function listGoogleShoppingFeedRowsAfter(
  db: PgQueryable,
  input: Readonly<{ afterRowId: string | null; limit: number }>,
): Promise<GoogleShoppingFeedRowForSync[]> {
  const result = await db.query<{
    row_id: string;
    listing_id: string;
    merchant_offer_id: string;
    payload: unknown;
    payload_hash: string | null;
    eligibility_status: string;
    exclusion_reasons: unknown;
    sync_status: string;
    last_submitted_payload_hash: string | null;
    tombstone_status: string;
    delete_submitted_at: Date | string | null;
  }>(
    `SELECT row_id,
            listing_id,
            merchant_offer_id,
            payload,
            payload_hash,
            eligibility_status,
            exclusion_reasons,
            sync_status,
            last_submitted_payload_hash,
            tombstone_status,
            delete_submitted_at
     FROM discovery_google_shopping_feed_rows
     WHERE ($1::text IS NULL OR row_id > $1)
     ORDER BY row_id ASC
     LIMIT $2`,
    [input.afterRowId, input.limit],
  );

  return result.rows.map((row) => ({
    rowId: row.row_id,
    listingId: row.listing_id,
    merchantOfferId: row.merchant_offer_id,
    payload: readJsonValue<GoogleShoppingPayloadInput | null>(row.payload),
    payloadHash: row.payload_hash,
    eligibilityStatus: row.eligibility_status,
    exclusionReasons: row.exclusion_reasons,
    syncStatus: row.sync_status,
    lastSubmittedPayloadHash: row.last_submitted_payload_hash,
    tombstoneStatus: row.tombstone_status,
    deleteSubmittedAt: row.delete_submitted_at == null ? null : formatTimestamp(row.delete_submitted_at),
  }));
}

async function listGoogleShoppingFeedRowsByListingIds(
  db: PgQueryable,
  listingIds: readonly string[],
): Promise<GoogleShoppingFeedRowForSync[]> {
  if (listingIds.length === 0) {
    return [];
  }

  const result = await db.query<{
    row_id: string;
    listing_id: string;
    merchant_offer_id: string;
    payload: unknown;
    payload_hash: string | null;
    eligibility_status: string;
    exclusion_reasons: unknown;
    sync_status: string;
    last_submitted_payload_hash: string | null;
    tombstone_status: string;
    delete_submitted_at: Date | string | null;
  }>(
    `SELECT row_id,
            listing_id,
            merchant_offer_id,
            payload,
            payload_hash,
            eligibility_status,
            exclusion_reasons,
            sync_status,
            last_submitted_payload_hash,
            tombstone_status,
            delete_submitted_at
     FROM discovery_google_shopping_feed_rows
     WHERE listing_id = ANY($1)
     ORDER BY array_position($1::text[], listing_id) ASC`,
    [listingIds],
  );

  return result.rows.map((row) => ({
    rowId: row.row_id,
    listingId: row.listing_id,
    merchantOfferId: row.merchant_offer_id,
    payload: readJsonValue<GoogleShoppingPayloadInput | null>(row.payload),
    payloadHash: row.payload_hash,
    eligibilityStatus: row.eligibility_status,
    exclusionReasons: row.exclusion_reasons,
    syncStatus: row.sync_status,
    lastSubmittedPayloadHash: row.last_submitted_payload_hash,
    tombstoneStatus: row.tombstone_status,
    deleteSubmittedAt: row.delete_submitted_at == null ? null : formatTimestamp(row.delete_submitted_at),
  }));
}

async function listGoogleShoppingCleanupCandidates(
  db: PgQueryable,
  limit: number,
): Promise<GoogleShoppingMaintenanceCandidate[]> {
  const result = await db.query<GoogleShoppingMaintenanceCandidateRow>(
    `SELECT 'cleanup' AS action,
            row_id,
            listing_id,
            merchant_offer_id,
            eligibility_status,
            tombstone_status,
            sync_status,
            payload_hash,
            last_submitted_payload_hash,
            last_submitted_at,
            last_accepted_at,
            delete_submitted_at
     FROM discovery_google_shopping_feed_rows
     WHERE last_submitted_payload_hash IS NOT NULL
       AND delete_submitted_at IS NULL
       AND (tombstone_status <> 'live' OR eligibility_status <> 'eligible')
     ORDER BY updated_at ASC, row_id ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map(toGoogleShoppingMaintenanceCandidate);
}

async function listGoogleShoppingRefreshCandidates(
  db: PgQueryable,
  input: Readonly<{ refreshCutoff: string; limit: number }>,
): Promise<GoogleShoppingMaintenanceCandidate[]> {
  const result = await db.query<GoogleShoppingMaintenanceCandidateRow>(
    `SELECT 'refresh' AS action,
            row_id,
            listing_id,
            merchant_offer_id,
            eligibility_status,
            tombstone_status,
            sync_status,
            payload_hash,
            last_submitted_payload_hash,
            last_submitted_at,
            last_accepted_at,
            delete_submitted_at
     FROM discovery_google_shopping_feed_rows
     WHERE eligibility_status = 'eligible'
       AND tombstone_status = 'live'
       AND payload IS NOT NULL
       AND payload_hash IS NOT NULL
       AND last_submitted_payload_hash IS NOT NULL
       AND delete_submitted_at IS NULL
       AND COALESCE(last_accepted_at, last_submitted_at) IS NOT NULL
       AND COALESCE(last_accepted_at, last_submitted_at) <= $1::timestamptz
     ORDER BY COALESCE(last_accepted_at, last_submitted_at) ASC, row_id ASC
     LIMIT $2`,
    [input.refreshCutoff, input.limit],
  );

  return result.rows.map(toGoogleShoppingMaintenanceCandidate);
}

async function listGoogleShoppingDiagnosticsRowsAfter(
  db: PgQueryable,
  input: Readonly<{ afterRowId: string | null; limit: number }>,
): Promise<GoogleShoppingFeedRowForDiagnostics[]> {
  const result = await db.query<{
    row_id: string;
    listing_id: string;
    account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    merchant_offer_id: string;
    external_seller_id: string;
    diagnostic_issues: unknown;
  }>(
    `SELECT row_id,
            listing_id,
            account_id,
            catalog_catalog_item_id,
            product_id,
            merchant_offer_id,
            external_seller_id,
            diagnostic_issues
     FROM discovery_google_shopping_feed_rows
     WHERE ($1::text IS NULL OR row_id > $1)
       AND last_submitted_payload_hash IS NOT NULL
       AND delete_submitted_at IS NULL
     ORDER BY row_id ASC
     LIMIT $2`,
    [input.afterRowId, input.limit],
  );

  return result.rows.map((row) => ({
    rowId: row.row_id,
    listingId: row.listing_id,
    accountId: row.account_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    merchantOfferId: row.merchant_offer_id,
    externalSellerId: row.external_seller_id,
    diagnosticIssues: row.diagnostic_issues,
  }));
}

async function countGoogleShoppingDiagnosticsCandidates(db: PgQueryable): Promise<number> {
  const result = await db.query<{ total: number | string }>(
    `SELECT COUNT(*)::integer AS total
     FROM discovery_google_shopping_feed_rows
     WHERE last_submitted_payload_hash IS NOT NULL
       AND delete_submitted_at IS NULL`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function processGoogleShoppingDiagnosticsRow(input: {
  db: PgQueryable;
  row: GoogleShoppingFeedRowForDiagnostics;
  mode: GoogleShoppingSyncMode;
  merchantClient: GoogleShoppingSyncMerchantClient;
  signal?: AbortSignal;
  jobContext: DurableJobExecutionContext<GoogleShoppingFullSyncJobProgress, GoogleShoppingFullSyncJobResult>;
  previousIssueChunkSize?: number;
}): Promise<GoogleShoppingDiagnosticsRowOutcome> {
  const attemptedAt = new Date().toISOString();
  if (!input.merchantClient.getProcessedProductStatus) {
    if (input.mode === "live") {
      await recordGoogleShoppingDiagnosticsFailure(input.db, input.row.rowId, {
        attemptedAt,
        code: "google_shopping_diagnostics_unavailable",
        message: t("discovery.googleShoppingOperations.sync.diagnosticsUnavailable"),
        response: { operation: "get-processed-product" },
        providerRequestId: null,
      });
    }
    return failedGoogleShoppingDiagnosticsOutcome();
  }

  try {
    const result = await runGoogleShoppingSyncSideEffect(input.jobContext, (signal) =>
      input.merchantClient.getProcessedProductStatus!(input.row.merchantOfferId, { signal }),
    );

    if (result.status === "dry-run") {
      return { outcome: "skipped", status: "unknown", activeIssues: 0, unknownIssueCodes: 0, resolvedIssues: 0 };
    }

    if (result.status === "success" && result.diagnostics) {
      const normalized = normalizeGoogleShoppingDiagnostics(
        input.row.diagnosticIssues,
        result.diagnostics,
        attemptedAt,
        { previousIssueChunkSize: input.previousIssueChunkSize },
      );
      if (input.mode === "live") {
        await recordGoogleShoppingDiagnosticsResult(input.db, input.row.rowId, {
          attemptedAt,
          result,
          normalized,
        });
      }
      return {
        outcome: "checked",
        status: normalized.status,
        activeIssues: normalized.activeIssues.length,
        unknownIssueCodes: normalized.activeIssues.filter((issue) => !issue.known).length,
        resolvedIssues: normalized.resolvedIssues,
      };
    }

    if (isGoogleShoppingSyncProviderFailure(result) && input.mode === "live") {
      await recordGoogleShoppingDiagnosticsFailure(input.db, input.row.rowId, {
        attemptedAt,
        code: result.error.code,
        message: result.error.message,
        response: result,
        providerRequestId: result.error.providerRequestId,
      });
    }
    return failedGoogleShoppingDiagnosticsOutcome();
  } catch (error) {
    if (isDurableJobHandoffError(error, { signal: input.signal })) {
      throw error;
    }
    if (input.mode === "live") {
      await recordGoogleShoppingDiagnosticsFailure(input.db, input.row.rowId, {
        attemptedAt,
        code: "google_shopping_diagnostics_exception",
        message: error instanceof Error ? error.message : "Google Shopping diagnostics refresh failed.",
        response: { error: error instanceof Error ? error.message : String(error) },
        providerRequestId: null,
      });
    }
    return failedGoogleShoppingDiagnosticsOutcome();
  }
}

async function getGoogleShoppingDiagnosticsSnapshot(
  db: PgQueryable,
  input: Readonly<{ limit: number }>,
): Promise<GoogleShoppingDiagnosticsSnapshot> {
  const result = await db.query<{
    row_id: string;
    listing_id: string;
    account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    merchant_offer_id: string;
    external_seller_id: string;
    diagnostic_status: string | null;
    diagnostic_destination_statuses: unknown;
    diagnostic_issues: unknown;
    last_diagnostic_at: Date | string | null;
  }>(
    `SELECT row_id,
            listing_id,
            account_id,
            catalog_catalog_item_id,
            product_id,
            merchant_offer_id,
            external_seller_id,
            diagnostic_status,
            diagnostic_destination_statuses,
            diagnostic_issues,
            last_diagnostic_at
     FROM discovery_google_shopping_feed_rows
     WHERE last_submitted_payload_hash IS NOT NULL
       AND delete_submitted_at IS NULL
     ORDER BY COALESCE(last_diagnostic_at, 'epoch'::timestamptz) DESC, row_id ASC
     LIMIT $1`,
    [input.limit],
  );
  const rows = result.rows.map((row) => ({
    rowId: row.row_id,
    listingId: row.listing_id,
    accountId: row.account_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    merchantOfferId: row.merchant_offer_id,
    externalSellerId: row.external_seller_id,
    diagnosticStatus: readGoogleShoppingDiagnosticStatus(row.diagnostic_status),
    destinationStatuses: readJsonValue<readonly unknown[]>(row.diagnostic_destination_statuses),
    lastDiagnosticAt: row.last_diagnostic_at == null ? null : formatTimestamp(row.last_diagnostic_at),
    issues: diagnosticIssueSnapshots(row.diagnostic_issues),
  }));

  return buildGoogleShoppingDiagnosticsSnapshot(rows, new Date().toISOString());
}

async function listGoogleShoppingFeedRows(
  db: PgQueryable,
  input: Readonly<{
    filter?: GoogleShoppingFeedRowFilter;
    search?: string;
    limit?: number;
    refreshWindowDays?: number;
    now?: string | Date;
  }> = {},
): Promise<GoogleShoppingFeedRowList> {
  const filter = normalizeFeedRowFilter(input.filter);
  const search = input.search?.trim() ?? "";
  const limit = normalizeBatchSize(input.limit ?? DEFAULT_BATCH_SIZE);
  const refreshWindowDays = normalizePositiveInteger(input.refreshWindowDays, DEFAULT_REFRESH_WINDOW_DAYS);
  const refreshCutoff = refreshCutoffFor(input.now, refreshWindowDays).toISOString();
  const where = googleShoppingFeedRowWhere(filter, search, refreshCutoff);
  const summaryResult = await db.query<GoogleShoppingFeedRowSummaryDbRow>(
    `SELECT COUNT(*)::integer AS total_rows,
            COUNT(*) FILTER (WHERE eligibility_status = 'eligible')::integer AS eligible_rows,
            COUNT(*) FILTER (WHERE eligibility_status <> 'eligible')::integer AS excluded_rows,
            COUNT(*) FILTER (WHERE sync_status = 'failed')::integer AS failed_rows,
            COUNT(*) FILTER (WHERE diagnostic_status = 'disapproved')::integer AS disapproved_rows,
            COUNT(*) FILTER (
              WHERE last_submitted_payload_hash IS NOT NULL
                AND delete_submitted_at IS NULL
                AND (tombstone_status <> 'live' OR eligibility_status <> 'eligible')
            )::integer AS pending_delete_rows,
            COUNT(*) FILTER (
              WHERE eligibility_status = 'eligible'
                AND tombstone_status = 'live'
                AND last_submitted_payload_hash IS NOT NULL
                AND payload_hash IS DISTINCT FROM last_submitted_payload_hash
            )::integer AS stale_rows,
            COUNT(*) FILTER (
              WHERE eligibility_status = 'eligible'
                AND tombstone_status = 'live'
                AND last_submitted_payload_hash IS NOT NULL
                AND COALESCE(last_accepted_at, last_submitted_at) <= $1::timestamptz
            )::integer AS nearing_refresh_rows,
            COUNT(*) FILTER (
              WHERE last_submitted_payload_hash IS NOT NULL
                AND delete_submitted_at IS NULL
                AND COALESCE(diagnostic_status, 'unknown') IN ('pending', 'unknown')
            )::integer AS pending_diagnostics_rows
     FROM discovery_google_shopping_feed_rows`,
    [refreshCutoff],
  );
  const rowResult = await db.query<GoogleShoppingFeedRowListDbRow>(
    `SELECT row_id,
            listing_id,
            account_id,
            catalog_catalog_item_id,
            product_id,
            merchant_offer_id,
            external_seller_id,
            canonical_url,
            target_country,
            content_language,
            feed_label,
            payload_hash,
            eligibility_status,
            exclusion_reasons,
            image_eligibility_status,
            image_exclusion_reasons,
            shipping_policy_url,
            return_policy_url,
            return_policy_label,
            sync_status,
            last_submitted_payload_hash,
            last_submitted_at,
            last_accepted_at,
            last_sync_attempted_at,
            last_sync_error_code,
            last_sync_error_message,
            last_provider_operation,
            diagnostic_status,
            diagnostic_issues,
            last_diagnostic_at,
            tombstone_status,
            delete_submitted_at,
            updated_at
     FROM discovery_google_shopping_feed_rows
     ${where.sql}
     ORDER BY ${googleShoppingFeedRowOrder(filter)}
     LIMIT $${where.values.length + 1}`,
    [...where.values, limit],
  );
  const summary = summaryResult.rows[0] ?? {
    total_rows: 0,
    eligible_rows: 0,
    excluded_rows: 0,
    failed_rows: 0,
    disapproved_rows: 0,
    pending_delete_rows: 0,
    stale_rows: 0,
    nearing_refresh_rows: 0,
    pending_diagnostics_rows: 0,
  };

  return {
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    filter,
    search,
    limit,
    refreshWindowDays,
    refreshCutoff,
    summary: {
      totalRows: Number(summary.total_rows),
      eligibleRows: Number(summary.eligible_rows),
      excludedRows: Number(summary.excluded_rows),
      failedRows: Number(summary.failed_rows),
      disapprovedRows: Number(summary.disapproved_rows),
      pendingDeleteRows: Number(summary.pending_delete_rows),
      staleRows: Number(summary.stale_rows),
      nearingRefreshRows: Number(summary.nearing_refresh_rows),
      pendingDiagnosticsRows: Number(summary.pending_diagnostics_rows),
    },
    rows: rowResult.rows.map((row) => toGoogleShoppingFeedRowListItem(row, refreshCutoff)),
  };
}

function googleShoppingFeedRowWhere(filter: GoogleShoppingFeedRowFilter, search: string, refreshCutoff: string) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  switch (filter) {
    case "eligible":
      clauses.push("eligibility_status = 'eligible'");
      break;
    case "excluded":
      clauses.push("eligibility_status <> 'eligible'");
      break;
    case "failed":
      clauses.push("sync_status = 'failed'");
      break;
    case "disapproved":
      clauses.push("diagnostic_status = 'disapproved'");
      break;
    case "pending-delete":
      clauses.push(
        "last_submitted_payload_hash IS NOT NULL AND delete_submitted_at IS NULL AND (tombstone_status <> 'live' OR eligibility_status <> 'eligible')",
      );
      break;
    case "nearing-refresh":
      clauses.push(
        `eligibility_status = 'eligible' AND tombstone_status = 'live' AND last_submitted_payload_hash IS NOT NULL AND COALESCE(last_accepted_at, last_submitted_at) <= ${parameter(refreshCutoff)}::timestamptz`,
      );
      break;
    case "stale":
      clauses.push(
        "eligibility_status = 'eligible' AND tombstone_status = 'live' AND last_submitted_payload_hash IS NOT NULL AND payload_hash IS DISTINCT FROM last_submitted_payload_hash",
      );
      break;
    case "pending-diagnostics":
      clauses.push(
        "last_submitted_payload_hash IS NOT NULL AND delete_submitted_at IS NULL AND COALESCE(diagnostic_status, 'unknown') IN ('pending', 'unknown')",
      );
      break;
    case "all":
      break;
  }

  if (search) {
    const searchParameter = parameter(`%${escapeLikePattern(search.toLowerCase())}%`);
    clauses.push(
      `(lower(row_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(listing_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(account_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(catalog_catalog_item_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(product_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(merchant_offer_id) LIKE ${searchParameter} ESCAPE '\\' OR lower(external_seller_id) LIKE ${searchParameter} ESCAPE '\\')`,
    );
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function googleShoppingFeedRowOrder(filter: GoogleShoppingFeedRowFilter) {
  switch (filter) {
    case "failed":
      return "last_sync_attempted_at DESC NULLS LAST, updated_at DESC, row_id ASC";
    case "disapproved":
    case "pending-diagnostics":
      return "last_diagnostic_at DESC NULLS LAST, updated_at DESC, row_id ASC";
    case "pending-delete":
    case "stale":
    case "nearing-refresh":
      return "updated_at ASC, row_id ASC";
    default:
      return "updated_at DESC, row_id ASC";
  }
}

function normalizeFeedRowFilter(value: unknown): GoogleShoppingFeedRowFilter {
  return value === "eligible" ||
    value === "excluded" ||
    value === "failed" ||
    value === "disapproved" ||
    value === "pending-delete" ||
    value === "nearing-refresh" ||
    value === "stale" ||
    value === "pending-diagnostics"
    ? value
    : "all";
}

function toGoogleShoppingFeedRowListItem(
  row: GoogleShoppingFeedRowListDbRow,
  refreshCutoff: string,
): GoogleShoppingFeedRowListItem {
  const exclusionReasons = readStringArray(row.exclusion_reasons);
  const imageExclusionReasons = readStringArray(row.image_exclusion_reasons);
  const activeIssues = diagnosticIssueSnapshots(row.diagnostic_issues).filter((issue) => !issue.resolvedAt);
  const pendingDelete =
    row.last_submitted_payload_hash !== null &&
    row.delete_submitted_at === null &&
    (row.tombstone_status !== "live" || row.eligibility_status !== "eligible");
  const stale =
    row.eligibility_status === "eligible" &&
    row.tombstone_status === "live" &&
    row.last_submitted_payload_hash !== null &&
    row.payload_hash !== row.last_submitted_payload_hash;
  const lastAcceptedOrSubmittedAt = row.last_accepted_at ?? row.last_submitted_at;
  const nearingRefresh =
    row.eligibility_status === "eligible" &&
    row.tombstone_status === "live" &&
    row.last_submitted_payload_hash !== null &&
    lastAcceptedOrSubmittedAt !== null &&
    new Date(lastAcceptedOrSubmittedAt).getTime() <= new Date(refreshCutoff).getTime();

  return {
    rowId: row.row_id,
    listingId: row.listing_id,
    accountId: row.account_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    merchantOfferId: row.merchant_offer_id,
    externalSellerId: row.external_seller_id,
    canonicalUrl: row.canonical_url,
    targetCountry: row.target_country,
    contentLanguage: row.content_language,
    feedLabel: row.feed_label,
    eligibilityStatus: row.eligibility_status,
    exclusionReasons,
    imageEligibilityStatus: row.image_eligibility_status,
    imageExclusionReasons,
    syncStatus: row.sync_status,
    diagnosticStatus: readGoogleShoppingDiagnosticStatus(row.diagnostic_status),
    activeIssueCount: activeIssues.length,
    unknownIssueCodeCount: activeIssues.filter((issue) => !issue.known).length,
    blockingIssueCount:
      exclusionReasons.length + imageExclusionReasons.length + (row.last_sync_error_code ? 1 : 0) + activeIssues.length,
    remediationOwners: googleShoppingRemediationOwners({
      exclusionReasons,
      imageExclusionReasons,
      activeIssues,
      syncStatus: row.sync_status,
      diagnosticStatus: row.diagnostic_status,
      pendingDelete,
    }),
    pendingDelete,
    stale,
    nearingRefresh,
    payloadHash: row.payload_hash,
    lastSubmittedPayloadHash: row.last_submitted_payload_hash,
    lastSubmittedAt: row.last_submitted_at == null ? null : formatTimestamp(row.last_submitted_at),
    lastAcceptedAt: row.last_accepted_at == null ? null : formatTimestamp(row.last_accepted_at),
    lastSyncAttemptedAt: row.last_sync_attempted_at == null ? null : formatTimestamp(row.last_sync_attempted_at),
    lastSyncErrorCode: row.last_sync_error_code,
    lastSyncErrorMessage: row.last_sync_error_message,
    lastProviderOperation: row.last_provider_operation,
    deleteSubmittedAt: row.delete_submitted_at == null ? null : formatTimestamp(row.delete_submitted_at),
    lastDiagnosticAt: row.last_diagnostic_at == null ? null : formatTimestamp(row.last_diagnostic_at),
    shippingPolicyUrl: row.shipping_policy_url,
    returnPolicyUrl: row.return_policy_url,
    returnPolicyLabel: row.return_policy_label,
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function readStringArray(value: unknown): readonly string[] {
  const parsed = readJsonValue<unknown>(value);
  return Array.isArray(parsed) ? parsed.map((entry) => String(entry)).filter(Boolean) : [];
}

function googleShoppingRemediationOwners(input: {
  exclusionReasons: readonly string[];
  imageExclusionReasons: readonly string[];
  activeIssues: readonly GoogleShoppingDiagnosticIssueSnapshot[];
  syncStatus: string;
  diagnosticStatus: string | null;
  pendingDelete: boolean;
}): readonly string[] {
  const owners = new Set<string>();
  const reasons = [...input.exclusionReasons, ...input.imageExclusionReasons].join(" ").toLowerCase();

  if (/(image|title|description|catalog|condition|product|option)/.test(reasons)) {
    owners.add("Catalog");
  }
  if (/(listing|price|availability|quantity|seller-unavailable|tombstone)/.test(reasons) || input.pendingDelete) {
    owners.add("Marketplace");
  }
  if (/(crawl|canonical|url|policy|robots|sitemap)/.test(reasons)) {
    owners.add("Public Presence");
  }
  if (/(shipping|fulfillment)/.test(reasons)) {
    owners.add("Ordering/Fulfillment");
  }
  if (/tax/.test(reasons)) {
    owners.add("Tax");
  }
  if (/(account|seller|external_seller_id)/.test(reasons)) {
    owners.add("Identity");
  }
  if (input.syncStatus === "failed") {
    owners.add("Platform Runtime");
  }
  if (input.diagnosticStatus === "disapproved" || input.activeIssues.some((issue) => !issue.known)) {
    owners.add("Ops / Google Merchant Center");
  }

  if (owners.size === 0) {
    owners.add("Discovery");
  }

  return [...owners];
}

async function countGoogleShoppingFeedRows(db: PgQueryable): Promise<number> {
  const result = await db.query<{ total: number | string }>(
    `SELECT COUNT(*)::integer AS total FROM discovery_google_shopping_feed_rows`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function recordGoogleShoppingRowSubmitted(
  db: PgQueryable,
  row: GoogleShoppingFeedRowForSync,
  input: Readonly<{ attemptedAt: string; result: GoogleShoppingSyncProviderResult }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'submitted',
         last_submitted_payload_hash = $2,
         last_submitted_at = $3::timestamptz,
         last_sync_attempted_at = $3::timestamptz,
         last_sync_error_code = NULL,
         last_sync_error_message = NULL,
         last_provider_request_id = NULL,
         last_provider_operation = $4,
         last_provider_response = $5::jsonb,
         delete_submitted_at = NULL,
         updated_at = now()
     WHERE row_id = $1`,
    [
      row.rowId,
      row.payloadHash,
      input.attemptedAt,
      input.result.operation,
      JSON.stringify(safeProviderResponse(input.result)),
    ],
  );
}

async function recordGoogleShoppingRowDeleted(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{ attemptedAt: string; result: GoogleShoppingSyncProviderResult }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'deleted',
         delete_submitted_at = $2::timestamptz,
         last_sync_attempted_at = $2::timestamptz,
         last_sync_error_code = NULL,
         last_sync_error_message = NULL,
         last_provider_request_id = NULL,
         last_provider_operation = $3,
         last_provider_response = $4::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [rowId, input.attemptedAt, input.result.operation, JSON.stringify(safeProviderResponse(input.result))],
  );
}

async function recordGoogleShoppingRowFailure(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{
    attemptedAt: string;
    operation: GoogleShoppingSyncProviderOperation;
    code: string;
    message: string;
    providerRequestId: string | null;
    response: unknown;
  }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET sync_status = 'failed',
         last_sync_attempted_at = $2::timestamptz,
         last_sync_error_code = $3,
         last_sync_error_message = $4,
         last_provider_request_id = $5,
         last_provider_operation = $6,
         last_provider_response = $7::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [
      rowId,
      input.attemptedAt,
      input.code.slice(0, 200),
      input.message.slice(0, 1_000),
      input.providerRequestId,
      input.operation,
      JSON.stringify(safeProviderResponse(input.response)),
    ],
  );
}

async function recordGoogleShoppingDiagnosticsResult(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{
    attemptedAt: string;
    result: GoogleShoppingSyncProviderResult;
    normalized: ReturnType<typeof normalizeGoogleShoppingDiagnostics>;
  }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET diagnostic_status = $2,
         diagnostic_destination_statuses = $3::jsonb,
         diagnostic_issues = $4::jsonb,
         last_diagnostic_at = $5::timestamptz,
         last_sync_error_code = NULL,
         last_sync_error_message = NULL,
         last_provider_request_id = NULL,
         last_provider_operation = $6,
         last_provider_response = $7::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [
      rowId,
      input.normalized.status,
      JSON.stringify(input.normalized.destinationStatuses),
      JSON.stringify(input.normalized.issues),
      input.attemptedAt,
      input.result.operation,
      JSON.stringify(safeProviderResponse(input.result)),
    ],
  );
}

async function recordGoogleShoppingDiagnosticsFailure(
  db: PgQueryable,
  rowId: string,
  input: Readonly<{
    attemptedAt: string;
    code: string;
    message: string;
    providerRequestId: string | null;
    response: unknown;
  }>,
) {
  await db.query(
    `UPDATE discovery_google_shopping_feed_rows
     SET diagnostic_status = COALESCE(diagnostic_status, 'unknown'),
         last_diagnostic_at = $2::timestamptz,
         last_sync_error_code = $3,
         last_sync_error_message = $4,
         last_provider_request_id = $5,
         last_provider_operation = 'get-processed-product',
         last_provider_response = $6::jsonb,
         updated_at = now()
     WHERE row_id = $1`,
    [
      rowId,
      input.attemptedAt,
      input.code.slice(0, 200),
      input.message.slice(0, 1_000),
      input.providerRequestId,
      JSON.stringify(safeProviderResponse(input.response)),
    ],
  );
}

async function runGoogleShoppingSyncSideEffect<T>(
  jobContext: DurableJobExecutionContext<GoogleShoppingFullSyncJobProgress, GoogleShoppingFullSyncJobResult>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runDurableJobSideEffect(jobContext, work, {
    renewIntervalMs: 5_000,
    claimLostMessage: "Google Shopping full sync job claim was lost while calling Merchant API.",
  });
}

function googleShoppingSyncProgress(
  input: Readonly<Partial<GoogleShoppingFullSyncJobProgress>> &
    Pick<GoogleShoppingFullSyncJobProgress, "phase" | "completed" | "total" | "currentRowId" | "message">,
): GoogleShoppingFullSyncJobProgress {
  return {
    phase: input.phase,
    completed: input.completed,
    total: input.total,
    currentRowId: input.currentRowId,
    submitted: input.submitted ?? 0,
    skipped: input.skipped ?? 0,
    deleted: input.deleted ?? 0,
    failed: input.failed ?? 0,
    excluded: input.excluded ?? 0,
    message: input.message,
  };
}

function addGoogleShoppingSyncOutcome(
  progress: GoogleShoppingFullSyncJobProgress,
  rowId: string,
  outcome: "submitted" | "skipped" | "deleted" | "failed" | "excluded",
): GoogleShoppingFullSyncJobProgress {
  return {
    ...progress,
    completed: progress.completed + 1,
    currentRowId: rowId,
    submitted: progress.submitted + (outcome === "submitted" ? 1 : 0),
    skipped: progress.skipped + (outcome === "skipped" ? 1 : 0),
    deleted: progress.deleted + (outcome === "deleted" ? 1 : 0),
    failed: progress.failed + (outcome === "failed" ? 1 : 0),
    excluded: progress.excluded + (outcome === "excluded" ? 1 : 0),
    message: t("discovery.googleShoppingOperations.sync.rowProcessed"),
  };
}

function toGoogleShoppingSyncResult(
  mode: GoogleShoppingSyncMode,
  progress: GoogleShoppingFullSyncJobProgress,
): GoogleShoppingFullSyncJobResult {
  return {
    mode,
    submitted: progress.submitted,
    skipped: progress.skipped,
    deleted: progress.deleted,
    failed: progress.failed,
    excluded: progress.excluded,
    total: progress.total,
  };
}

function shouldPatchPriceAndAvailability(reasons: readonly GoogleShoppingIncrementalSyncReason[]) {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => reason === "price" || reason === "availability" || reason === "seller-availability")
  );
}

function shouldForceScheduledRefresh(reasons: readonly GoogleShoppingIncrementalSyncReason[]) {
  return reasons.includes("scheduled-refresh");
}

function toGoogleShoppingMaintenanceCandidate(
  row: GoogleShoppingMaintenanceCandidateRow,
): GoogleShoppingMaintenanceCandidate {
  return {
    action: row.action,
    rowId: row.row_id,
    listingId: row.listing_id,
    merchantOfferId: row.merchant_offer_id,
    eligibilityStatus: row.eligibility_status,
    tombstoneStatus: row.tombstone_status,
    syncStatus: row.sync_status,
    payloadHash: row.payload_hash,
    lastSubmittedPayloadHash: row.last_submitted_payload_hash,
    lastSubmittedAt: row.last_submitted_at == null ? null : formatTimestamp(row.last_submitted_at),
    lastAcceptedAt: row.last_accepted_at == null ? null : formatTimestamp(row.last_accepted_at),
    deleteSubmittedAt: row.delete_submitted_at == null ? null : formatTimestamp(row.delete_submitted_at),
  };
}

export function normalizeGoogleShoppingDiagnostics(
  previousIssuesValue: unknown,
  diagnostics: GoogleShoppingProductDiagnostics,
  observedAt: string,
  options: GoogleShoppingDiagnosticsNormalizationOptions = {},
) {
  const previousIssueChunkSize = normalizeBatchSize(
    options.previousIssueChunkSize ?? DEFAULT_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE,
  );
  const activeIssueDrafts = diagnostics.issues.map((issue) => ({
    issue,
    key: diagnosticIssueKey(issue),
  }));
  // Key-only lookup bounded by current provider issues for one row, not by total catalog size.
  const activeIssueKeys = new Set(activeIssueDrafts.map((draft) => draft.key));
  // Values are retained only for active keys, so this map is bounded by current provider issues for one row.
  const previousByActiveKey = new Map<string, GoogleShoppingDiagnosticIssueSnapshot>();
  const resolvedIssues: GoogleShoppingDiagnosticIssueSnapshot[] = [];
  const retainedResolvedIssues: GoogleShoppingDiagnosticIssueSnapshot[] = [];

  for (const previousIssueChunk of diagnosticIssueSnapshotChunks(previousIssuesValue, previousIssueChunkSize)) {
    for (const previousIssue of previousIssueChunk) {
      const key = diagnosticIssueKey(previousIssue);
      if (activeIssueKeys.has(key)) {
        previousByActiveKey.set(key, previousIssue);
        continue;
      }

      if (previousIssue.resolvedAt) {
        retainedResolvedIssues.push(previousIssue);
      } else {
        resolvedIssues.push({ ...previousIssue, resolvedAt: observedAt });
      }
    }
  }

  const activeIssues = activeIssueDrafts.map(({ issue, key }) => {
    const previous = previousByActiveKey.get(key);
    return {
      code: normalizedIssueText(issue.code, "unknown_issue"),
      severity: normalizedIssueText(issue.severity, "UNKNOWN"),
      resolution: issue.resolution,
      attribute: issue.attribute,
      reportingContext: issue.reportingContext,
      description: issue.description,
      detail: issue.detail,
      documentation: issue.documentation,
      applicableCountries: issue.applicableCountries,
      firstSeenAt: previous?.resolvedAt ? observedAt : (previous?.firstSeenAt ?? observedAt),
      lastSeenAt: observedAt,
      resolvedAt: null,
      known: isKnownGoogleShoppingIssueCode(issue.code),
    } satisfies GoogleShoppingDiagnosticIssueSnapshot;
  });
  const status = googleShoppingDiagnosticStatus(diagnostics.destinationStatuses, activeIssues);

  return {
    status,
    destinationStatuses: diagnostics.destinationStatuses,
    activeIssues,
    resolvedIssues: resolvedIssues.length,
    issues: [...activeIssues, ...resolvedIssues, ...retainedResolvedIssues],
  };
}

function googleShoppingDiagnosticStatus(
  destinationStatuses: readonly unknown[],
  activeIssues: readonly GoogleShoppingDiagnosticIssueSnapshot[],
): GoogleShoppingDiagnosticStatus {
  if (activeIssues.some((issue) => issue.severity.toUpperCase().includes("DISAPPROVED"))) {
    return "disapproved";
  }
  if (activeIssues.length > 0) {
    return "approved_with_issues";
  }
  if (destinationStatuses.length === 0) {
    return "unknown";
  }
  if (JSON.stringify(destinationStatuses).toLowerCase().includes("pending")) {
    return "pending";
  }

  return "approved";
}

function readGoogleShoppingDiagnosticStatus(value: string | null): GoogleShoppingDiagnosticStatus | null {
  return value === "approved" ||
    value === "approved_with_issues" ||
    value === "disapproved" ||
    value === "pending" ||
    value === "unknown"
    ? value
    : null;
}

function buildGoogleShoppingDiagnosticsSnapshot(
  rows: readonly GoogleShoppingDiagnosticsSnapshotRow[],
  generatedAt: string,
): GoogleShoppingDiagnosticsSnapshot {
  const totals = {
    rows: rows.length,
    approved: rows.filter((row) => row.diagnosticStatus === "approved").length,
    disapproved: rows.filter((row) => row.diagnosticStatus === "disapproved").length,
    pending: rows.filter((row) => row.diagnosticStatus === "pending").length,
    approvedWithIssues: rows.filter((row) => row.diagnosticStatus === "approved_with_issues").length,
    unknown: rows.filter((row) => !row.diagnosticStatus || row.diagnosticStatus === "unknown").length,
  };
  const activeIssues = rows.flatMap((row) => row.issues.filter((issue) => !issue.resolvedAt));
  const activeIssueSeverityCounts = countBy(activeIssues.map((issue) => issue.severity));
  const unknownIssueCodeCount = activeIssues.filter((issue) => !issue.known).length;
  const reasons = [
    ...(totals.disapproved > 0 ? [`${totals.disapproved} submitted Google Shopping row(s) are disapproved.`] : []),
    ...(unknownIssueCodeCount > 0 ? [`${unknownIssueCodeCount} active provider issue code(s) are unknown.`] : []),
    ...(totals.approvedWithIssues >= 5 ? [`${totals.approvedWithIssues} row(s) have active Merchant issues.`] : []),
  ];

  return {
    generatedAt,
    totals,
    activeIssueSeverityCounts,
    unknownIssueCodeCount,
    launchImpact: {
      p0: totals.disapproved > 0,
      p1: unknownIssueCodeCount > 0 || totals.approvedWithIssues >= 5,
      reasons,
    },
    rows,
  };
}

function emptyGoogleShoppingDiagnosticsRefreshResult(
  mode: GoogleShoppingSyncMode,
  total: number,
): GoogleShoppingDiagnosticsRefreshResult {
  return {
    mode,
    checked: 0,
    approved: 0,
    disapproved: 0,
    pending: 0,
    approvedWithIssues: 0,
    failed: 0,
    unknownIssueCodes: 0,
    resolvedIssues: 0,
    total,
  };
}

function addGoogleShoppingDiagnosticsOutcome(
  result: GoogleShoppingDiagnosticsRefreshResult,
  outcome: GoogleShoppingDiagnosticsRowOutcome,
): GoogleShoppingDiagnosticsRefreshResult {
  return {
    ...result,
    checked: result.checked + (outcome.outcome === "checked" ? 1 : 0),
    approved: result.approved + (outcome.status === "approved" ? 1 : 0),
    disapproved: result.disapproved + (outcome.status === "disapproved" ? 1 : 0),
    pending: result.pending + (outcome.status === "pending" ? 1 : 0),
    approvedWithIssues: result.approvedWithIssues + (outcome.status === "approved_with_issues" ? 1 : 0),
    failed: result.failed + (outcome.outcome === "failed" ? 1 : 0),
    unknownIssueCodes: result.unknownIssueCodes + outcome.unknownIssueCodes,
    resolvedIssues: result.resolvedIssues + outcome.resolvedIssues,
  };
}

function failedGoogleShoppingDiagnosticsOutcome(): GoogleShoppingDiagnosticsRowOutcome {
  return { outcome: "failed", status: "unknown", activeIssues: 0, unknownIssueCodes: 0, resolvedIssues: 0 };
}

function diagnosticIssueSnapshots(value: unknown): GoogleShoppingDiagnosticIssueSnapshot[] {
  const parsed = readJsonValue<unknown>(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    const snapshot = diagnosticIssueSnapshot(entry);
    return snapshot ? [snapshot] : [];
  });
}

function* diagnosticIssueSnapshotChunks(
  value: unknown,
  chunkSize: number,
): Generator<GoogleShoppingDiagnosticIssueSnapshot[]> {
  const parsed = readJsonValue<unknown>(value);
  if (!Array.isArray(parsed)) {
    return;
  }

  const normalizedChunkSize = normalizeBatchSize(chunkSize);
  let chunk: GoogleShoppingDiagnosticIssueSnapshot[] = [];
  for (const entry of parsed) {
    const snapshot = diagnosticIssueSnapshot(entry);
    if (!snapshot) {
      continue;
    }

    chunk.push(snapshot);
    if (chunk.length >= normalizedChunkSize) {
      yield chunk;
      chunk = [];
    }
  }

  if (chunk.length > 0) {
    yield chunk;
  }
}

function diagnosticIssueSnapshot(entry: unknown): GoogleShoppingDiagnosticIssueSnapshot | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  return {
    code: normalizedIssueText(record.code, "unknown_issue"),
    severity: normalizedIssueText(record.severity, "UNKNOWN"),
    resolution: stringOrNull(record.resolution),
    attribute: stringOrNull(record.attribute),
    reportingContext: stringOrNull(record.reportingContext),
    description: stringOrNull(record.description),
    detail: stringOrNull(record.detail),
    documentation: stringOrNull(record.documentation),
    applicableCountries: Array.isArray(record.applicableCountries)
      ? record.applicableCountries.flatMap((country) => (typeof country === "string" ? [country] : []))
      : [],
    firstSeenAt: stringOrNull(record.firstSeenAt) ?? new Date(0).toISOString(),
    lastSeenAt: stringOrNull(record.lastSeenAt) ?? new Date(0).toISOString(),
    resolvedAt: stringOrNull(record.resolvedAt),
    known: typeof record.known === "boolean" ? record.known : isKnownGoogleShoppingIssueCode(record.code),
  };
}

function diagnosticIssueKey(issue: GoogleShoppingProductIssue | GoogleShoppingDiagnosticIssueSnapshot) {
  return [
    normalizedIssueText(issue.code, "unknown_issue"),
    issue.attribute ?? "",
    issue.reportingContext ?? "",
    [...issue.applicableCountries].sort().join(","),
  ].join("|");
}

function normalizedIssueText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isKnownGoogleShoppingIssueCode(value: unknown) {
  const code = normalizedIssueText(value, "unknown_issue").toLowerCase();
  return knownGoogleShoppingIssueCodes.has(code);
}

const knownGoogleShoppingIssueCodes = new Set([
  "account_disapproved",
  "adult_oriented_content",
  "image_link_pending_crawl",
  "image_too_small",
  "invalid_gtin",
  "invalid_image",
  "invalid_price",
  "landing_page_not_crawlable",
  "missing_image_link",
  "missing_price",
  "missing_shipping",
  "policy_violation",
  "price_mismatch",
  "product_unavailable",
]);

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function refreshCutoffFor(value: string | Date | undefined, refreshWindowDays: number): Date {
  const now = value ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) {
    return refreshCutoffFor(undefined, refreshWindowDays);
  }

  return new Date(now.getTime() - refreshWindowDays * 24 * 60 * 60 * 1000);
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number) {
  const parsed = Math.floor(value ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function normalizeBatchSize(value: number | undefined) {
  const parsed = Math.floor(value ?? DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.max(1, Math.min(parsed, MAX_BATCH_SIZE));
}

function createJobId(): string {
  return createInternalId("job");
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function retentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function requireGoogleShoppingSyncClaim(succeeded: Promise<boolean> | boolean) {
  if (!(await succeeded)) {
    throw new Error("Google Shopping full sync job claim was lost before the status update completed.");
  }
}

function throwIfGoogleShoppingSyncCancelled(input?: { signal?: AbortSignal; throwIfLeaseLost?: () => void }) {
  input?.throwIfLeaseLost?.();
  if (input?.signal?.aborted) {
    throw new Error("Google Shopping full sync job was cancelled.");
  }
}

function safeProviderResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(safeProviderResponse);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      key.toLowerCase() === "body" ? "[omitted]" : safeProviderResponse(entry),
    ]),
  );
}

function isGoogleShoppingSyncProviderFailure(
  result: GoogleShoppingSyncProviderResult,
): result is Extract<GoogleShoppingSyncProviderResult, { status: "permanent-failure" | "transient-failure" }> {
  return result.status === "permanent-failure" || result.status === "transient-failure";
}
