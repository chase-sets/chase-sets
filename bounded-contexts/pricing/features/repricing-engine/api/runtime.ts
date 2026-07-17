import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresDurableJobStore, type DurableJobRecord } from "@chase-sets/platform-runtime/durable-job-store";
import {
  evaluateRepricingListing,
  type RepricingListingEvaluation,
  type RepricingMarketInputSnapshot,
} from "../domain/evaluate";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingEvaluationSkipReason,
  type RepricingPolicyEvaluatedEvent,
  type RepricingPolicyListingTrace,
} from "../domain/fact";
import { buildRepricingEvaluationProjectionHandlers } from "../read-model/projection";
import {
  getRepricingProductForListing,
  hasEvaluationStream,
  listAssignedRepricingProducts,
  loadRepricingRoundInputs,
  type RepricingRoundListing,
} from "../read-model/queries";

const REPRICING_EVALUATION_JOB_KIND = "repricing-evaluation";
const DAILY_SWEEP_NAME = "assigned-products";
const DEFAULT_SWEEP_LIMIT = 500;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

const REPRICING_SYSTEM_CONTEXT: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_pricing_system" as never,
    forAccountId: "acc_pricing_system" as never,
  },
};

export type RepricingEvaluationTrigger = Readonly<{
  kind: "market-price-estimated" | "competing-ask-changed" | "daily-drift-sweep";
  eventId: string;
  signalVersion: string;
  occurredAt: string;
}>;

type RepricingEvaluationJobPayload = Readonly<{
  catalogItemId: string;
  productId: string;
  trigger: RepricingEvaluationTrigger;
}>;

type RepricingEvaluationJobProgress = Readonly<{
  phase: "queued" | "evaluating" | "completed" | "failed";
  policiesEvaluated: number;
  listingsEvaluated: number;
  listingsChanged: number;
}>;

type RepricingEvaluationJobResult = Readonly<{
  policiesEvaluated: number;
  listingsEvaluated: number;
  listingsChanged: number;
}>;

export type RepricingMarketplaceGateway = Readonly<{
  applyBulkListingPriceUpdates: (body: {
    updates: readonly Readonly<{ listingId: string; priceAmount: string; expectedVersion: number }>[];
  }) => Promise<{
    items: readonly Readonly<{
      listingId: string;
      outcome: "applied" | "no_op" | "conflict" | "error";
      message?: string;
    }>[];
  }>;
}>;

type RepricingEngineRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgTransactionalPool;
}>;

export type RepricingEngineServices = Readonly<{
  enqueueMarketPriceSignal: (
    input: Readonly<{
      catalogItemId: string;
      productId: string;
      amount: string;
      previousAmount: string | null;
      trigger: RepricingEvaluationTrigger;
      context: EventStoreContext;
    }>,
  ) => Promise<boolean>;
  enqueueCompetingAskSignal: (
    input: Readonly<{
      listingId: string;
      trigger: RepricingEvaluationTrigger;
      context: EventStoreContext;
    }>,
  ) => Promise<boolean>;
  enqueueDailyDriftSweep: (input?: Readonly<{ now?: string; limit?: number }>) => Promise<number>;
  previewProductRound: (
    input: Readonly<{
      catalogItemId: string;
      productId: string;
      now?: string;
    }>,
  ) => Promise<readonly RepricingListingEvaluation[]>;
  processNextEvaluationJob: (
    input: Readonly<{
      claimOwnerId: string;
      claimTtlMs: number;
      marketplaceGatewayForAccount: (accountId: string) => RepricingMarketplaceGateway;
      signal?: AbortSignal;
      throwIfLeaseLost?: () => void;
    }>,
  ) => Promise<number>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createRepricingEngineRuntime(deps: RepricingEngineRuntimeDeps): RepricingEngineServices {
  const jobStore = createPostgresDurableJobStore<
    RepricingEvaluationJobPayload,
    RepricingEvaluationJobProgress,
    RepricingEvaluationJobResult
  >(deps.db, {
    jobsTable: "pricing_repricing_evaluation_jobs",
    eventsTable: "pricing_repricing_evaluation_job_events",
  });
  const factCodec = createPassthroughDomainEventCodec<RepricingPolicyEvaluatedEvent>();

  async function enqueue(payload: RepricingEvaluationJobPayload, context: EventStoreContext): Promise<boolean> {
    try {
      await jobStore.enqueue({
        jobId: evaluationJobId(payload.trigger.eventId),
        jobKind: REPRICING_EVALUATION_JOB_KIND,
        payload,
        progress: { phase: "queued", policiesEvaluated: 0, listingsEvaluated: 0, listingsChanged: 0 },
        eventContext: context,
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  const enqueueMarketPriceSignal: RepricingEngineServices["enqueueMarketPriceSignal"] = async (input) => {
    // Market estimates republish unchanged once per UTC day to advance their
    // freshness horizon. That is not a moved signal; the daily drift sweep
    // handles quiet-listing drift without manufacturing a reactive round.
    if (input.previousAmount === input.amount) {
      return false;
    }
    return enqueue(
      { catalogItemId: input.catalogItemId, productId: input.productId, trigger: input.trigger },
      input.context,
    );
  };

  const enqueueCompetingAskSignal: RepricingEngineServices["enqueueCompetingAskSignal"] = async (input) => {
    const product = await getRepricingProductForListing(deps.db, input.listingId);
    if (!product) {
      return false;
    }
    return enqueue({ ...product, trigger: input.trigger }, input.context);
  };

  const enqueueDailyDriftSweep: RepricingEngineServices["enqueueDailyDriftSweep"] = async (input = {}) => {
    const now = input.now ? new Date(input.now) : new Date();
    const nowIso = now.toISOString();
    const day = nowIso.slice(0, 10);
    const cursorResult = await deps.db.query<{
      sweep_day: string;
      after_catalog_item_id: string | null;
      after_product_id: string | null;
      completed: boolean;
    }>(
      `SELECT sweep_day::text, after_catalog_item_id, after_product_id, completed
       FROM pricing_repricing_daily_sweep_cursor
       WHERE sweep_name = $1`,
      [DAILY_SWEEP_NAME],
    );
    const stored = cursorResult.rows[0];
    const currentDay = stored?.sweep_day === day;
    if (currentDay && stored.completed) {
      return 0;
    }
    const after =
      currentDay && stored?.after_catalog_item_id && stored.after_product_id
        ? { catalogItemId: stored.after_catalog_item_id, productId: stored.after_product_id }
        : null;
    const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
    const products = await listAssignedRepricingProducts(deps.db, { after, limit });
    let enqueued = 0;
    for (const product of products) {
      const eventId = `daily-drift-sweep:${day}:${product.catalogItemId}:${product.productId}`;
      if (
        await enqueue(
          {
            ...product,
            trigger: {
              kind: "daily-drift-sweep",
              eventId,
              signalVersion: day,
              occurredAt: nowIso,
            },
          },
          REPRICING_SYSTEM_CONTEXT,
        )
      ) {
        enqueued += 1;
      }
    }
    const last = products.at(-1);
    await deps.db.query(
      `INSERT INTO pricing_repricing_daily_sweep_cursor (
         sweep_name, sweep_day, after_catalog_item_id, after_product_id, completed, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sweep_name) DO UPDATE SET
         sweep_day = EXCLUDED.sweep_day,
         after_catalog_item_id = EXCLUDED.after_catalog_item_id,
         after_product_id = EXCLUDED.after_product_id,
         completed = EXCLUDED.completed,
         updated_at = EXCLUDED.updated_at`,
      [
        DAILY_SWEEP_NAME,
        day,
        products.length < limit ? null : (last?.catalogItemId ?? null),
        products.length < limit ? null : (last?.productId ?? null),
        products.length < limit,
        nowIso,
      ],
    );
    return enqueued;
  };

  const previewProductRound: RepricingEngineServices["previewProductRound"] = async (input) => {
    const round = await loadRepricingRoundInputs(deps.db, input);
    return evaluateRound(round, input.now ?? new Date().toISOString());
  };

  const processNextEvaluationJob: RepricingEngineServices["processNextEvaluationJob"] = async (input) => {
    const claimed = await jobStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      jobKinds: [REPRICING_EVALUATION_JOB_KIND],
    });
    if (!claimed) {
      return 0;
    }
    const progress: RepricingEvaluationJobProgress = {
      phase: "evaluating",
      policiesEvaluated: 0,
      listingsEvaluated: 0,
      listingsChanged: 0,
    };
    try {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) {
        throw new Error("Repricing evaluation job was cancelled.");
      }
      await jobStore.updateProgress({
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        progress,
      });
      const result = await executeProductRound(deps, factCodec, claimed, input);
      await jobStore.complete({
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        progress: { phase: "completed", ...result },
        result,
      });
      return 1;
    } catch (error) {
      await jobStore.fail({
        jobId: claimed.jobId,
        claimOwnerId: input.claimOwnerId,
        progress: { ...progress, phase: "failed" },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return {
    enqueueMarketPriceSignal,
    enqueueCompetingAskSignal,
    enqueueDailyDriftSweep,
    previewProductRound,
    processNextEvaluationJob,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-repricing-evaluation-projection",
        handlers: buildRepricingEvaluationProjectionHandlers(deps.db),
      }),
    ],
  };
}

async function executeProductRound(
  deps: RepricingEngineRuntimeDeps,
  factCodec: ReturnType<typeof createPassthroughDomainEventCodec<RepricingPolicyEvaluatedEvent>>,
  job: DurableJobRecord<RepricingEvaluationJobPayload, RepricingEvaluationJobProgress, RepricingEvaluationJobResult>,
  input: Readonly<{
    marketplaceGatewayForAccount: (accountId: string) => RepricingMarketplaceGateway;
    throwIfLeaseLost?: () => void;
  }>,
): Promise<RepricingEvaluationJobResult> {
  const nowIso = new Date().toISOString();
  const round = await loadRepricingRoundInputs(deps.db, job.payload);
  const evaluations = evaluateRound(round, nowIso);
  const byPolicy = new Map<string, Array<{ listing: RepricingRoundListing; evaluation: RepricingListingEvaluation }>>();
  round.listings.forEach((listing, index) => {
    const entries = byPolicy.get(listing.policyId) ?? [];
    entries.push({ listing, evaluation: evaluations[index]! });
    byPolicy.set(listing.policyId, entries);
  });

  type PolicyPlan = Readonly<{
    policyId: string;
    entries: readonly Readonly<{ listing: RepricingRoundListing; evaluation: RepricingListingEvaluation }>[];
    first: Readonly<{ listing: RepricingRoundListing; evaluation: RepricingListingEvaluation }>;
    evaluationId: string;
    streamId: string;
    reserved: number;
    allowedIds: ReadonlySet<string>;
    commandEntries: readonly Readonly<{ listing: RepricingRoundListing; evaluation: RepricingListingEvaluation }>[];
  }>;
  const plans: PolicyPlan[] = [];
  for (const [policyId, entries] of byPolicy) {
    input.throwIfLeaseLost?.();
    const first = entries[0]!;
    const evaluationId = buildEvaluationId(job.payload.trigger.eventId, policyId, first.listing.policyRevision);
    const streamId = evaluationStreamId(evaluationId);
    if (await hasEvaluationStream(deps.db, streamId)) {
      continue;
    }
    const eligible = entries
      .filter((entry) => entry.evaluation.action === "update-price" && entry.evaluation.targetPriceAmount !== null)
      .sort((left, right) => left.listing.listingId.localeCompare(right.listing.listingId));
    const reserved = await reserveDailyChanges(
      deps.db,
      policyId,
      nowIso.slice(0, 10),
      first.listing.maxChangesPerDay,
      eligible.length,
    );
    const allowedIds = new Set(eligible.slice(0, reserved).map((entry) => entry.listing.listingId));
    plans.push({
      policyId,
      entries,
      first,
      evaluationId,
      streamId,
      reserved,
      allowedIds,
      commandEntries: eligible.filter((entry) => allowedIds.has(entry.listing.listingId)),
    });
  }

  type CommandOutcome = Readonly<{
    listingId: string;
    outcome: "applied" | "no_op" | "conflict" | "error";
    message?: string;
  }>;
  const outcomesByListingId = new Map<string, CommandOutcome>();
  const commandsByAccount = new Map<
    string,
    Array<Readonly<{ listingId: string; priceAmount: string; expectedVersion: number }>>
  >();
  for (const plan of plans) {
    const accountCommands = commandsByAccount.get(plan.first.listing.sellerAccountId) ?? [];
    accountCommands.push(
      ...plan.commandEntries.map((entry) => ({
        listingId: entry.listing.listingId,
        priceAmount: entry.evaluation.targetPriceAmount!,
        expectedVersion: entry.listing.listingVersion,
      })),
    );
    commandsByAccount.set(plan.first.listing.sellerAccountId, accountCommands);
  }
  // Exactly one command-path call per account in the simultaneous product
  // round: Marketplace therefore opens one terms session and applies the
  // whole round through its existing chunked append lane.
  for (const [accountId, updates] of commandsByAccount) {
    if (updates.length === 0) {
      continue;
    }
    try {
      const result = await input.marketplaceGatewayForAccount(accountId).applyBulkListingPriceUpdates({ updates });
      result.items.forEach((outcome) => outcomesByListingId.set(outcome.listingId, outcome));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updates.forEach((update) =>
        outcomesByListingId.set(update.listingId, { listingId: update.listingId, outcome: "error", message }),
      );
    }
  }

  let policiesEvaluated = 0;
  let listingsEvaluated = 0;
  let listingsChanged = 0;
  for (const plan of plans) {
    input.throwIfLeaseLost?.();
    const changed = plan.commandEntries.filter(
      (entry) => outcomesByListingId.get(entry.listing.listingId)?.outcome === "applied",
    ).length;
    if (plan.reserved > changed) {
      await refundDailyChanges(deps.db, plan.policyId, nowIso.slice(0, 10), plan.reserved - changed);
    }

    const traces = plan.entries.map(({ listing, evaluation }): RepricingPolicyListingTrace => {
      if (evaluation.action === "pause") {
        return traceFromEvaluation(evaluation, "pause-requested", "terminal-pause");
      }
      if (evaluation.action === "notify-only") {
        return traceFromEvaluation(evaluation, "notify-only", "terminal-notify-only");
      }
      if (evaluation.action !== "update-price") {
        return traceFromEvaluation(
          evaluation,
          "skipped",
          (evaluation.skipReason ?? "anchor-chain-exhausted") as RepricingEvaluationSkipReason,
        );
      }
      if (!plan.allowedIds.has(listing.listingId)) {
        return traceFromEvaluation(evaluation, "skipped", "budget-exhausted");
      }
      const outcome = outcomesByListingId.get(listing.listingId);
      switch (outcome?.outcome) {
        case "applied":
          return traceFromEvaluation(evaluation, "changed", null);
        case "conflict":
          return traceFromEvaluation(evaluation, "skipped", "manual-edit-conflict");
        case "no_op":
          return traceFromEvaluation(evaluation, "skipped", "domain-no-op");
        case "error":
        default:
          return traceFromEvaluation(evaluation, "skipped", "command-error");
      }
    });
    const evaluatedAt = new Date().toISOString();
    const fact: RepricingPolicyEvaluatedEvent = {
      type: repricingPolicyEvaluatedEventType,
      data: {
        schemaVersion: 1,
        evaluationId: plan.evaluationId,
        policyId: plan.policyId,
        policyRevision: plan.first.listing.policyRevision,
        sellerAccountId: plan.first.listing.sellerAccountId,
        catalogItemId: job.payload.catalogItemId,
        productId: job.payload.productId,
        trigger: job.payload.trigger,
        listingsEvaluated: traces.length,
        listingsChanged: traces.filter((trace) => trace.outcome === "changed").length,
        listingsSkipped: traces.filter((trace) => trace.outcome !== "changed").length,
        listings: traces,
        signalToEvaluationLatencyMs: Math.min(
          MAX_POSTGRES_INTEGER,
          Math.max(0, Date.parse(evaluatedAt) - Date.parse(job.payload.trigger.occurredAt)),
        ),
        evaluatedAt,
      },
    };
    try {
      await deps.eventStore.appendToStream({
        streamId: plan.streamId,
        expectedVersion: "no_stream",
        events: [factCodec.encode(fact)],
        context: REPRICING_SYSTEM_CONTEXT,
      });
    } catch (error) {
      if (!isConcurrencyConflict(error)) {
        throw error;
      }
    }
    policiesEvaluated += 1;
    listingsEvaluated += traces.length;
    listingsChanged += changed;
  }

  return { policiesEvaluated, listingsEvaluated, listingsChanged };
}

function evaluateRound(
  round: Awaited<ReturnType<typeof loadRepricingRoundInputs>>,
  capturedAt: string,
): readonly RepricingListingEvaluation[] {
  return round.listings.map((listing) => {
    const snapshot: RepricingMarketInputSnapshot = {
      catalogItemId: listing.catalogItemId,
      productId: listing.productId,
      capturedAt,
      marketEstimate: round.marketEstimate,
      lastSoldAmount: round.lastSoldAmount,
      competingAsks: round.competingAsks,
    };
    return evaluateRepricingListing(
      {
        listingId: listing.listingId,
        sellerAccountId: listing.sellerAccountId,
        currentPriceAmount: listing.priceAmount,
        quantityCap: listing.quantityCap,
        categoryIds: listing.categoryIds,
        // The merged m113 source snapshot does not publish these two
        // attributes. Conditions that depend on them therefore do not match;
        // the mandatory default rule remains deterministic.
        grading: null,
        createdAt: null,
        costBasisAmount: listing.costBasisAmount,
        rules: listing.rules,
      },
      snapshot,
    );
  });
}

function traceFromEvaluation(
  evaluation: RepricingListingEvaluation,
  outcome: RepricingPolicyListingTrace["outcome"],
  skipReason: RepricingEvaluationSkipReason | null,
): RepricingPolicyListingTrace {
  return {
    listingId: evaluation.listingId,
    currentPriceAmount: evaluation.currentPriceAmount,
    targetPriceAmount: evaluation.targetPriceAmount,
    ruleIndex: evaluation.ruleIndex,
    anchor: evaluation.anchor,
    exhaustedAnchors: evaluation.exhaustedAnchors,
    clamps: evaluation.clamps,
    flags: evaluation.flags,
    outcome,
    skipReason,
  };
}

async function reserveDailyChanges(
  db: PgTransactionalPool,
  policyId: string,
  day: string,
  limit: number,
  requested: number,
): Promise<number> {
  if (requested === 0) {
    return 0;
  }
  return withPgTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO pricing_repricing_daily_change_budgets (policy_id, budget_day, changes_reserved, updated_at)
       VALUES ($1, $2, 0, now())
       ON CONFLICT (policy_id, budget_day) DO NOTHING`,
      [policyId, day],
    );
    const current = await client.query<{ changes_reserved: number }>(
      `SELECT changes_reserved
       FROM pricing_repricing_daily_change_budgets
       WHERE policy_id = $1 AND budget_day = $2
       FOR UPDATE`,
      [policyId, day],
    );
    const remaining = Math.max(0, limit - Number(current.rows[0]?.changes_reserved ?? 0));
    const reserved = Math.min(remaining, requested);
    if (reserved > 0) {
      await client.query(
        `UPDATE pricing_repricing_daily_change_budgets
         SET changes_reserved = changes_reserved + $3,
             updated_at = now()
         WHERE policy_id = $1 AND budget_day = $2`,
        [policyId, day, reserved],
      );
    }
    return reserved;
  });
}

async function refundDailyChanges(
  db: PgTransactionalPool,
  policyId: string,
  day: string,
  amount: number,
): Promise<void> {
  await db.query(
    `UPDATE pricing_repricing_daily_change_budgets
     SET changes_reserved = GREATEST(0, changes_reserved - $3),
         updated_at = now()
     WHERE policy_id = $1 AND budget_day = $2`,
    [policyId, day, amount],
  );
}

function evaluationJobId(eventId: string): string {
  return `repricing-evaluation:${eventId}`;
}

function buildEvaluationId(eventId: string, policyId: string, policyRevision: string): string {
  return `${encodeURIComponent(eventId)}:${encodeURIComponent(policyId)}:${Date.parse(policyRevision)}`;
}

function evaluationStreamId(evaluationId: string): string {
  return `pricing.repricing-evaluation-${evaluationId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "concurrency_conflict";
}
