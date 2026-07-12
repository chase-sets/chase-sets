import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
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
import { chunkItems, defaultLaneYield } from "@chase-sets/platform-runtime/bulk-append-lane";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { createInternalId } from "@chase-sets/primitives/typed-ids";
import {
  parseBulkRepriceCsv,
  parseBulkRepriceJsonRows,
  buildBulkRepriceResultsCsv,
  type BulkRepriceInputRow,
} from "../domain/csv";
import { bulkRepriceIngestionPolicy } from "../domain/policy";
import {
  countActiveBulkRepriceJobsForAccount,
  listBulkRepriceRows,
  summarizeBulkRepriceRowOutcomes,
  upsertBulkRepriceRows,
  type BulkRepriceRowUpsert,
} from "../read-model/queries";

export class BulkRepriceIngestionDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkRepriceIngestionDomainError";
  }
}

/**
 * The Marketplace port this feature drives to apply the diffed deltas --
 * the SAME chunked-append + per-account-terms-session path (the m113 throughput lane)
 * the recommendations feature already uses for its own bulk price updates.
 * Bulk reprice ingestion never creates listings and never mutates
 * Marketplace state any other way.
 */
export type BulkRepriceListingOutcome = Readonly<{
  listingId: string;
  outcome: "applied" | "no_op" | "conflict" | "error";
  message?: string;
}>;

export type BulkRepriceMarketplaceListingGateway = Readonly<{
  applyBulkListingPriceUpdates: (
    body: Readonly<{ updates: readonly Readonly<{ listingId: string; priceAmount: string }>[] }>,
  ) => Promise<Readonly<{ items: readonly BulkRepriceListingOutcome[] }>>;
}>;

/**
 * The Inventory port this feature drives for native-SKU resolution (m71
 * account_sku_mappings machinery reused via a dedicated batch endpoint --
 * see `bounded-contexts/inventory/features/import-batches/read-model/account-sku-mappings.ts`).
 * Rows that supply a `listingId` directly never call this gateway.
 */
export type BulkRepriceInventorySkuResolution =
  | Readonly<{ sellerSku: string; status: "missing" | "ambiguous" | "unmapped-item" }>
  | Readonly<{ sellerSku: string; status: "mapped"; inventoryItemId: string }>;

export type BulkRepriceInventorySkuGateway = Readonly<{
  resolveSellerSkusToInventoryItems: (
    sellerSkus: readonly string[],
  ) => Promise<readonly BulkRepriceInventorySkuResolution[]>;
}>;

export type BulkRepriceJobPayload = Readonly<{
  accountId: string;
  inputId: string;
  rowCount: number;
}>;

export type BulkRepriceJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  message: string | null;
}>;

export type BulkRepriceJobResult = Readonly<{
  applied: number;
  unchanged: number;
  failed: number;
  total: number;
}>;

export type BulkRepriceJob = DurableJobRecord<BulkRepriceJobPayload, BulkRepriceJobProgress, BulkRepriceJobResult>;
export type BulkRepriceJobStatus = DurableJobPublicSnapshot<BulkRepriceJobProgress, BulkRepriceJobResult>;

export function toBulkRepriceJobStatus(job: BulkRepriceJob): BulkRepriceJobStatus {
  return toDurableJobPublicSnapshot(job);
}

const BULK_REPRICE_JOB_KIND = "bulk-reprice";

type BulkRepriceRuntimeDeps = Readonly<{ db: PgQueryable }>;

function jobProgress(
  phase: BulkRepriceJobProgress["phase"],
  completed: number,
  total: number,
  message: string | null,
): BulkRepriceJobProgress {
  return { phase, completed, total, message };
}

function normalizeMoney(value: string): string {
  return Number(value).toFixed(2);
}

function isEligibleListingStatus(status: string): boolean {
  return status === "active" || status === "draft";
}

export type BulkRepriceIngestionServices = Readonly<{
  enqueueJob: (
    params: Readonly<{
      accountId: string;
      csvText?: string;
      rows?: readonly Readonly<{ sellerSku?: unknown; listingId?: unknown; newPriceAmount?: unknown }>[];
      sourceFilename?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<BulkRepriceJob>;
  getJob: (jobId: string) => Promise<BulkRepriceJob | null>;
  listJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly DurableJobEvent<BulkRepriceJobPayload, BulkRepriceJobProgress, BulkRepriceJobResult>[]>;
  waitForJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  cancelJob: (jobId: string, accountId: string) => Promise<BulkRepriceJob>;
  listJobRows: (
    jobId: string,
    params?: Readonly<{ limit?: number; offset?: number }>,
  ) => ReturnType<typeof listBulkRepriceRows>;
  getResultsCsv: (jobId: string) => Promise<string>;
  pruneJobRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNextBulkRepriceJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    marketplaceListingGatewayForAccount: (accountId: string) => BulkRepriceMarketplaceListingGateway;
    inventorySkuGatewayForAccount: (accountId: string) => BulkRepriceInventorySkuGateway;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
}>;

export function createBulkRepriceIngestionRuntime(deps: BulkRepriceRuntimeDeps): BulkRepriceIngestionServices {
  const jobStore = createPostgresDurableJobStore<BulkRepriceJobPayload, BulkRepriceJobProgress, BulkRepriceJobResult>(
    deps.db,
    { jobsTable: "pricing_bulk_reprice_jobs", eventsTable: "pricing_bulk_reprice_job_events" },
  );
  const policyResolver = createPolicyResolver({ db: deps.db });

  async function resolvePolicy() {
    return (await policyResolver.resolvePolicy(bulkRepriceIngestionPolicy)).value;
  }

  const enqueueJob: BulkRepriceIngestionServices["enqueueJob"] = async (params, context) => {
    const policy = await resolvePolicy();
    if (!policy.enabled) {
      throw new BulkRepriceIngestionDomainError("Bulk reprice ingestion is not enabled for this account.");
    }

    const rows = params.csvText ? parseBulkRepriceCsv(params.csvText) : parseBulkRepriceJsonRows(params.rows ?? []);
    if (rows.length === 0) {
      throw new BulkRepriceIngestionDomainError("Upload contains no rows.");
    }
    if (rows.length > policy.maxRowsPerUpload) {
      throw new BulkRepriceIngestionDomainError(
        `Upload has ${rows.length} rows, which exceeds the ${policy.maxRowsPerUpload}-row limit per upload.`,
      );
    }

    const activeJobCount = await countActiveBulkRepriceJobsForAccount(deps.db, { accountId: params.accountId });
    if (activeJobCount >= policy.maxActiveJobsPerAccount) {
      throw new BulkRepriceIngestionDomainError(
        "This account already has an active bulk reprice job. Wait for it to finish, or cancel it, before starting another.",
      );
    }

    const inputId = createInternalId("bri");
    await deps.db.query(
      `INSERT INTO pricing_bulk_reprice_job_inputs (input_id, account_id, rows, row_count, source_filename, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, now())`,
      [inputId, params.accountId, JSON.stringify(rows), rows.length, params.sourceFilename ?? null],
    );

    return jobStore.enqueue({
      jobId: createInternalId("job"),
      jobKind: BULK_REPRICE_JOB_KIND,
      payload: { accountId: params.accountId, inputId, rowCount: rows.length },
      progress: jobProgress("queued", 0, rows.length, "Bulk reprice job queued."),
      eventContext: context,
    });
  };

  const cancelJob: BulkRepriceIngestionServices["cancelJob"] = async (jobId, accountId) => {
    const job = await jobStore.get(jobId);
    if (!job || job.payload.accountId !== accountId) {
      throw new BulkRepriceIngestionDomainError("Bulk reprice job not found.");
    }
    const cancelled = await jobStore.cancel({
      jobId,
      progress: { ...job.progress, phase: "failed", message: "Cancelled by seller." },
      errorMessage: "Bulk reprice job was cancelled by the seller.",
      allowedStatuses: ["queued", "running"],
    });
    if (!cancelled) {
      throw new BulkRepriceIngestionDomainError("Bulk reprice job could not be cancelled.");
    }
    return cancelled;
  };

  const getResultsCsv: BulkRepriceIngestionServices["getResultsCsv"] = async (jobId) => {
    const rows = await listBulkRepriceRows(deps.db, { jobId });
    return buildBulkRepriceResultsCsv(rows);
  };

  const processNextBulkRepriceJob: BulkRepriceIngestionServices["processNextBulkRepriceJob"] = async (input) => {
    const claimed = await jobStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      jobKinds: [BULK_REPRICE_JOB_KIND],
    });
    if (!claimed) {
      return 0;
    }

    try {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) {
        throw new Error("Bulk reprice job was cancelled.");
      }
      if (!claimed.eventContext) {
        throw new Error("Bulk reprice job is missing event context.");
      }

      const jobContext = createDurableJobExecutionContext(jobStore, {
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        signal: input.signal,
        throwIfLeaseLost: input.throwIfLeaseLost,
        cancelledMessage: "Bulk reprice job was cancelled.",
        claimLostMessage: "Bulk reprice job claim was lost before the status update completed.",
      });
      const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
        minIntervalMs: 1_000,
        minCompletedDelta: 50,
        minRenewIntervalMs: 5_000,
        completed: (progress: BulkRepriceJobProgress) => progress.completed,
        isTerminal: (progress: BulkRepriceJobProgress) => progress.phase === "completed" || progress.phase === "failed",
      });

      const policy = await resolvePolicy();
      const accountId = claimed.payload.accountId;
      const marketplaceGateway = input.marketplaceListingGatewayForAccount(accountId);
      const inventoryGateway = input.inventorySkuGatewayForAccount(accountId);

      const inputResult = await deps.db.query<{ rows: unknown }>(
        `SELECT rows FROM pricing_bulk_reprice_job_inputs WHERE input_id = $1`,
        [claimed.payload.inputId],
      );
      const inputRows = (
        typeof inputResult.rows[0]?.rows === "string"
          ? JSON.parse(inputResult.rows[0].rows as string)
          : (inputResult.rows[0]?.rows ?? [])
      ) as BulkRepriceInputRow[];

      const waves = chunkItems(inputRows, policy.chunkSize);
      let completed = 0;

      for (const wave of waves) {
        jobContext.throwIfCancelled();
        await runDurableJobSideEffect(
          jobContext,
          () =>
            processBulkRepriceWave({
              db: deps.db,
              jobId: claimed.jobId,
              accountId,
              wave,
              marketplaceGateway,
              inventoryGateway,
            }),
          { renewIntervalMs: 5_000, claimLostMessage: "Bulk reprice job claim was lost while applying a wave." },
        );
        completed += wave.length;
        const runningSummary = await summarizeBulkRepriceRowOutcomes(deps.db, { jobId: claimed.jobId });
        await progressCheckpoint.checkpoint(
          jobProgress("processing", completed, inputRows.length, "Processed a wave of rows."),
          {
            applied: runningSummary.applied,
            unchanged: runningSummary.unchanged,
            failed: runningSummary.failed,
            total: inputRows.length,
          },
        );
        await defaultLaneYield(policy.yieldIntervalMs);
      }

      const summary = await summarizeBulkRepriceRowOutcomes(deps.db, { jobId: claimed.jobId });
      const succeeded = await jobStore.complete({
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        progress: jobProgress("completed", inputRows.length, inputRows.length, "Bulk reprice job completed."),
        result: {
          applied: summary.applied,
          unchanged: summary.unchanged,
          failed: summary.failed,
          total: summary.total,
        },
      });
      if (!succeeded) {
        throw new Error("Bulk reprice job claim was lost before completion.");
      }
      return 1;
    } catch (error) {
      if (isDurableJobHandoffError(error, input)) {
        return 0;
      }
      await jobStore.fail({
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        progress: {
          ...claimed.progress,
          phase: "failed",
          message: error instanceof Error ? error.message : "Bulk reprice job failed.",
        },
        errorMessage: error instanceof Error ? error.message : "Bulk reprice job failed.",
      });
      return 1;
    }
  };

  return {
    enqueueJob,
    getJob: (jobId) => jobStore.get(jobId),
    listJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    waitForJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    cancelJob,
    listJobRows: (jobId, params = {}) => listBulkRepriceRows(deps.db, { jobId, ...params }),
    getResultsCsv,
    pruneJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        limit: input.limit,
      }),
    processNextBulkRepriceJob,
  };
}

/**
 * Diff-first, single wave: resolve -> diff against the local listing
 * read model -> apply only the deltas through ONE Marketplace bulk call ->
 * persist every row's outcome. Isolated per wave so a 250k-row upload never
 * holds more than `chunkSize` rows' worth of resolution state in memory
 * and never blocks the append lock for longer than one chunk (the chunked bulk-append lane).
 */
async function processBulkRepriceWave(params: {
  db: PgQueryable;
  jobId: string;
  accountId: string;
  wave: readonly BulkRepriceInputRow[];
  marketplaceGateway: BulkRepriceMarketplaceListingGateway;
  inventoryGateway: BulkRepriceInventorySkuGateway;
}): Promise<void> {
  const { db, jobId, accountId, wave, marketplaceGateway, inventoryGateway } = params;
  const outcomes: BulkRepriceRowUpsert[] = [];

  const invalidRows = wave.filter((row) => row.validationErrors.length > 0);
  for (const row of invalidRows) {
    outcomes.push({
      rowNumber: row.rowNumber,
      sellerSku: row.sellerSku,
      listingId: row.listingId,
      requestedPriceAmount: row.newPriceAmount,
      resolvedListingId: null,
      previousPriceAmount: null,
      outcome: "failed",
      errorMessage: row.validationErrors.join(" "),
    });
  }

  const candidateRows = wave.filter((row) => row.validationErrors.length === 0);
  const candidateRowByNumber = new Map(candidateRows.map((row) => [row.rowNumber, row] as const));
  const skuOnlyRows = candidateRows.filter((row) => !row.listingId && row.sellerSku);
  const uniqueSkus = [...new Set(skuOnlyRows.map((row) => row.sellerSku as string))];
  const inventoryItemIdBySku = new Map<string, string>();
  const skuFailureReason = new Map<string, string>();

  if (uniqueSkus.length > 0) {
    const resolutions = await inventoryGateway.resolveSellerSkusToInventoryItems(uniqueSkus);
    for (const resolution of resolutions) {
      if (resolution.status === "mapped") {
        inventoryItemIdBySku.set(resolution.sellerSku, resolution.inventoryItemId);
      } else if (resolution.status === "missing") {
        skuFailureReason.set(
          resolution.sellerSku,
          `Seller SKU '${resolution.sellerSku}' is not registered for this account.`,
        );
      } else if (resolution.status === "ambiguous") {
        skuFailureReason.set(
          resolution.sellerSku,
          `Seller SKU '${resolution.sellerSku}' maps to more than one item for this account.`,
        );
      } else {
        skuFailureReason.set(
          resolution.sellerSku,
          `Seller SKU '${resolution.sellerSku}' is registered but has no matching inventory item.`,
        );
      }
    }
  }

  const directListingIds = [
    ...new Set(candidateRows.filter((row) => row.listingId).map((row) => row.listingId as string)),
  ];
  const resolvedInventoryItemIds = [...new Set(inventoryItemIdBySku.values())];

  const listingsByListingId = new Map<
    string,
    { listing_id: string; inventory_item_id: string | null; price_amount: string; status: string }
  >();
  const listingsByInventoryItemId = new Map<
    string,
    { listing_id: string; inventory_item_id: string | null; price_amount: string; status: string }
  >();

  if (directListingIds.length > 0 || resolvedInventoryItemIds.length > 0) {
    const result = await db.query<{
      listing_id: string;
      inventory_item_id: string | null;
      price_amount: string;
      status: string;
    }>(
      `SELECT listing_id, inventory_item_id, price_amount::text AS price_amount, status
       FROM pricing_market_listing_inputs
       WHERE seller_account_id = $1
         AND (listing_id = ANY($2::text[]) OR inventory_item_id = ANY($3::text[]))`,
      [accountId, directListingIds, resolvedInventoryItemIds],
    );
    for (const row of result.rows) {
      listingsByListingId.set(row.listing_id, row);
      if (row.inventory_item_id) {
        listingsByInventoryItemId.set(row.inventory_item_id, row);
      }
    }
  }

  const updatesByListingId = new Map<string, { rowNumber: number; priceAmount: string }>();
  const claimedListingIds = new Set<string>();

  for (const row of candidateRows) {
    let listing: { listing_id: string; price_amount: string; status: string } | undefined;
    let failureMessage: string | null = null;

    if (row.listingId) {
      listing = listingsByListingId.get(row.listingId);
      if (!listing) {
        failureMessage = `Listing '${row.listingId}' was not found for this account.`;
      }
    } else if (row.sellerSku) {
      const inventoryItemId = inventoryItemIdBySku.get(row.sellerSku);
      if (inventoryItemId) {
        listing = listingsByInventoryItemId.get(inventoryItemId);
        if (!listing) {
          failureMessage = `Seller SKU '${row.sellerSku}' has no active listing to reprice.`;
        }
      } else {
        failureMessage = skuFailureReason.get(row.sellerSku) ?? `Seller SKU '${row.sellerSku}' could not be resolved.`;
      }
    }

    if (!listing) {
      outcomes.push({
        rowNumber: row.rowNumber,
        sellerSku: row.sellerSku,
        listingId: row.listingId,
        requestedPriceAmount: row.newPriceAmount,
        resolvedListingId: null,
        previousPriceAmount: null,
        outcome: "failed",
        errorMessage: failureMessage ?? "Row could not be resolved to a listing.",
      });
      continue;
    }

    if (!isEligibleListingStatus(listing.status)) {
      outcomes.push({
        rowNumber: row.rowNumber,
        sellerSku: row.sellerSku,
        listingId: row.listingId,
        requestedPriceAmount: row.newPriceAmount,
        resolvedListingId: listing.listing_id,
        previousPriceAmount: listing.price_amount,
        outcome: "failed",
        errorMessage: `Listing '${listing.listing_id}' is '${listing.status}' and not eligible for repricing.`,
      });
      continue;
    }

    const requestedPrice = normalizeMoney(row.newPriceAmount as string);
    const previousPrice = normalizeMoney(listing.price_amount);

    if (requestedPrice === previousPrice) {
      outcomes.push({
        rowNumber: row.rowNumber,
        sellerSku: row.sellerSku,
        listingId: row.listingId,
        requestedPriceAmount: requestedPrice,
        resolvedListingId: listing.listing_id,
        previousPriceAmount: previousPrice,
        outcome: "unchanged",
        errorMessage: null,
      });
      continue;
    }

    if (claimedListingIds.has(listing.listing_id)) {
      outcomes.push({
        rowNumber: row.rowNumber,
        sellerSku: row.sellerSku,
        listingId: row.listingId,
        requestedPriceAmount: requestedPrice,
        resolvedListingId: listing.listing_id,
        previousPriceAmount: previousPrice,
        outcome: "failed",
        errorMessage: `Listing '${listing.listing_id}' already has a price update from an earlier row in this upload.`,
      });
      continue;
    }

    claimedListingIds.add(listing.listing_id);
    updatesByListingId.set(listing.listing_id, { rowNumber: row.rowNumber, priceAmount: requestedPrice });
  }

  if (updatesByListingId.size > 0) {
    const updates = [...updatesByListingId.entries()].map(([listingId, entry]) => ({
      listingId,
      priceAmount: entry.priceAmount,
    }));
    const bulkResult = await marketplaceGateway.applyBulkListingPriceUpdates({ updates });
    const outcomeByListingId = new Map(bulkResult.items.map((item) => [item.listingId, item] as const));

    for (const [listingId, entry] of updatesByListingId) {
      const marketplaceOutcome = outcomeByListingId.get(listingId);
      const rowNumber = entry.rowNumber;
      const sourceRow = candidateRowByNumber.get(rowNumber);
      const previousPrice = normalizeMoney(listingsByListingId.get(listingId)?.price_amount ?? "0");

      if (marketplaceOutcome && (marketplaceOutcome.outcome === "applied" || marketplaceOutcome.outcome === "no_op")) {
        outcomes.push({
          rowNumber,
          sellerSku: sourceRow?.sellerSku ?? null,
          listingId: sourceRow?.listingId ?? null,
          requestedPriceAmount: entry.priceAmount,
          resolvedListingId: listingId,
          previousPriceAmount: previousPrice,
          outcome: marketplaceOutcome.outcome === "applied" ? "applied" : "unchanged",
          errorMessage: null,
        });
      } else {
        outcomes.push({
          rowNumber,
          sellerSku: sourceRow?.sellerSku ?? null,
          listingId: sourceRow?.listingId ?? null,
          requestedPriceAmount: entry.priceAmount,
          resolvedListingId: listingId,
          previousPriceAmount: previousPrice,
          outcome: "failed",
          errorMessage: marketplaceOutcome?.message ?? "Marketplace did not apply this price update.",
        });
      }
    }
  }

  await upsertBulkRepriceRows(db, { jobId, rows: outcomes });
}
