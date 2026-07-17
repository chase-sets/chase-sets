import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { calculateBlendedMarketValueEstimate } from "../domain/blended-estimate";
import {
  decideMarketPriceEstimate,
  evolveMarketPriceEstimate,
  initialMarketPriceEstimateState,
  type MarketPriceEstimateCommand,
  type MarketPriceEstimateEvent,
  type MarketPriceEstimateState,
} from "../domain/domain";
import { marketEstimatePolicy, type MarketEstimatePolicyValue } from "../domain/estimate-policy";
import { buildPricingMarketEstimateProjectionHandlers } from "../read-model/projection";
import {
  getMarketPriceEstimate,
  listMarketEstimateCandidateTuples,
  loadComparableSales,
  type MarketEstimateProductTuple,
  type MarketPriceEstimateRecord,
} from "../read-model/queries";

/**
 * The Market-Value Estimate recompute pass. It RIDES the market-rollups
 * closer job (the m111 "job, not projection" seam -- see
 * ../../market-rollups/read-model/rollup-maintenance.ts for the full
 * rationale): pricing's services composition (../../../support/runtime-support/services.ts)
 * runs this pass after every rollup closer pass, so the issue's three
 * recompute triggers all arrive through one already-scheduled entry point --
 * new trades and fresh observations land in the candidate window within one
 * closer interval, and the daily refresh falls out of the decider's
 * same-UTC-day dedupe rule (an unchanged estimate republishes exactly once
 * per day, advancing `freshUntil`).
 *
 * Idempotent by construction: recomputing the same candidate with unchanged
 * inputs on the same day appends nothing (the aggregate decider no-ops), so
 * the every-few-minutes cadence costs stream reads, not events.
 */

const MARKET_ESTIMATE_SYSTEM_CONTEXT: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_pricing_system" as never,
    forAccountId: "acc_pricing_system" as never,
  },
};

const DEFAULT_CLOSER_LIMIT = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export type MarketEstimateCloserParams = Readonly<{
  /** Defaults to the current time. Exposed for deterministic tests. */
  now?: string;
  /** Bounds how many candidate products one pass recomputes. */
  limit?: number;
}>;

export type MarketEstimateCloserResult = Readonly<{
  candidatesConsidered: number;
  estimatesPublished: number;
  belowGate: number;
  unchanged: number;
}>;

export type MarketEstimatesServices = Readonly<{
  commandHandler: CommandHandler<MarketPriceEstimateCommand, MarketPriceEstimateState, MarketPriceEstimateEvent>;
  /** Rides the market-rollups closer job -- see the module header. */
  runMarketPriceEstimateCloser: (params?: MarketEstimateCloserParams) => Promise<MarketEstimateCloserResult>;
  getMarketPriceEstimate: (params: MarketEstimateProductTuple) => Promise<MarketPriceEstimateRecord | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

type MarketEstimatesRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  /** Pricing's mounted platform-policy runtime -- resolves the market-estimate policy. */
  policies: PolicyRuntime;
}>;

export function createMarketEstimatesRuntime(deps: MarketEstimatesRuntimeDeps): MarketEstimatesServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketPriceEstimateEvent>(),
    initialState: () => initialMarketPriceEstimateState,
    evolve: evolveMarketPriceEstimate,
    decide: decideMarketPriceEstimate,
  });

  const runMarketPriceEstimateCloser = async (
    params: MarketEstimateCloserParams = {},
  ): Promise<MarketEstimateCloserResult> => {
    // One consistent policy snapshot per pass, never re-resolved per product
    // (the Stat-Hygiene Policy's closer convention).
    const policy = (await deps.policies.resolvePolicy(marketEstimatePolicy)).value;
    const now = params.now ? new Date(params.now) : new Date();
    const nowIso = now.toISOString();
    const since = new Date(now.getTime() - policy.lookbackDays * MS_PER_DAY).toISOString();
    const limit = params.limit ?? DEFAULT_CLOSER_LIMIT;

    const tuples = await listMarketEstimateCandidateTuples(deps.db, { since, limit });
    let estimatesPublished = 0;
    let belowGate = 0;
    let unchanged = 0;

    for (const tuple of tuples) {
      const comparableSales = await loadComparableSales(deps.db, tuple, since);
      const estimate = calculateBlendedMarketValueEstimate(comparableSales, {
        now: nowIso,
        decayHalfLifeDays: policy.decayHalfLifeDays,
        sourceWeights: policy.sourceWeights,
        estimatePercentile: policy.estimatePercentile,
        bandLowPercentile: policy.bandLowPercentile,
        bandHighPercentile: policy.bandHighPercentile,
        minimumComparableSales: policy.minimumComparableSales,
        confidenceSampleSizes: policy.confidenceSampleSizes,
      });

      if (estimate.status !== "estimated") {
        belowGate += 1;
        continue;
      }

      const result = await commandHandler({
        streamId: marketPriceEstimateStreamId(tuple.productId),
        command: recomputeCommand(tuple, estimate, { nowIso, since, policy }),
        context: MARKET_ESTIMATE_SYSTEM_CONTEXT,
      });
      if (result.newEvents.length > 0) {
        estimatesPublished += 1;
      } else {
        unchanged += 1;
      }
    }

    return {
      candidatesConsidered: tuples.length,
      estimatesPublished,
      belowGate,
      unchanged,
    };
  };

  return {
    commandHandler,
    runMarketPriceEstimateCloser,
    getMarketPriceEstimate: (params) => getMarketPriceEstimate(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-market-price-estimate-projection",
        handlers: buildPricingMarketEstimateProjectionHandlers(deps.db),
      }),
    ],
  };
}

export function marketPriceEstimateStreamId(productId: string): string {
  return `pricing.market-price-estimate-${productId}`;
}

function recomputeCommand(
  tuple: MarketEstimateProductTuple,
  estimate: ReturnType<typeof calculateBlendedMarketValueEstimate>,
  input: Readonly<{ nowIso: string; since: string; policy: MarketEstimatePolicyValue }>,
): MarketPriceEstimateCommand {
  return {
    type: "RecomputeMarketPriceEstimate",
    catalogItemId: tuple.catalogItemId,
    productId: tuple.productId,
    estimate,
    window: { startedAt: input.since, endedAt: input.nowIso },
    currencyCode: "usd",
    estimatedAt: input.nowIso,
    freshUntil: new Date(Date.parse(input.nowIso) + input.policy.freshForHours * MS_PER_HOUR).toISOString(),
  };
}
