import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { MarketplaceListingServices } from "./runtime";
import {
  createPricingJobRunners,
  createBulkRepriceIngestionJobRunners,
  type PricingRecommendationServices,
  type RepricingEngineServices,
} from "@chase-sets/pricing/server";
import { listingAttempt } from "./listing-attempt";
import { listingBatchStreamId, lookupListingBatch, runListingBatch } from "./listing-batch";

describe("Pricing worker seller audit composition", () => {
  it.each(["recommendation", "bulk-reprice", "evaluation"] as const)(
    "replays a seller batch through the real %s gateway",
    async (kind) => {
      const { eventStore } = createInMemoryEventStore();
      const batch = {
        accountId: "acc_synthetic_seller",
        family: "listing.update-price",
        batchId: "synthetic_worker_batch_identity_000001",
      } as const;
      const target = {
        targetId: "lst_synthetic",
        attempt: listingAttempt({
          idempotencyKey: batch.batchId,
          mutationKind: batch.family,
          accountId: batch.accountId,
          targetId: "lst_synthetic",
          request: { priceAmount: "9.99", priceCurrencyCode: "USD" },
        }),
      };
      let appends = 0;
      const listings: Pick<MarketplaceListingServices, "applyBulkListingPriceUpdates"> = {
        applyBulkListingPriceUpdates: async (_params, context) => {
          const decisions = await runListingBatch({
            store: eventStore,
            batch,
            context,
            targets: [target],
            drive: async () => {
              appends++;
              await eventStore.appendToStream({
                streamId: "marketplace.listing-lst_synthetic",
                expectedVersion: "no_stream",
                context,
                events: [{ eventType: "synthetic.listing.price-updated", payload: {} }],
              });
              return new Map([[target.targetId, { outcome: "succeeded" as const, version: 1 }]]);
            },
          });
          return decisions.map((decision) => ({
            listingId: target.targetId,
            ...decision,
            outcome: decision.outcome === "succeeded" ? ("applied" as const) : decision.outcome,
          }));
        },
      };
      const auditGateway = async (
        gateway: Pick<
          ReturnType<
            Parameters<
              PricingRecommendationServices["processNextRecommendationJob"]
            >[0]["marketplaceListingGatewayForAccount"]
          >,
          "applyBulkListingPriceUpdates"
        >,
      ) => {
        const body = {
          batchId: batch.batchId,
          updates: [
            {
              listingId: target.targetId,
              priceAmount: "9.99",
              priceCurrencyCode: "USD",
              idempotencyKey: batch.batchId,
            },
          ],
        };
        expect((await gateway.applyBulkListingPriceUpdates(body)).items[0]?.outcome).toBe("applied");
        expect((await gateway.applyBulkListingPriceUpdates(body)).items[0]?.outcome).toBe("applied");
        return 1;
      };
      const processNext: PricingRecommendationServices["processNextRecommendationJob"] = async (input) =>
        auditGateway(input.marketplaceListingGatewayForAccount(batch.accountId));
      const processEvaluation: RepricingEngineServices["processNextEvaluationJob"] = async (input) =>
        auditGateway(input.marketplaceGatewayForAccount(batch.accountId));
      const services = {
        marketplace: { listings },
        inventory: { importBatches: {} },
        pricing: {
          recommendations: kind === "recommendation" ? { processNextRecommendationJob: processNext } : undefined,
          bulkRepriceIngestion: { processNextBulkRepriceJob: processNext },
          repricingEngine: kind === "evaluation" ? { processNextEvaluationJob: processEvaluation } : undefined,
        },
      };
      const factory = kind === "bulk-reprice" ? createBulkRepriceIngestionJobRunners : createPricingJobRunners;
      const runners = factory({
        services,
        config: {
          workerId: "synthetic-worker",
          leaseTtlMs: 1000,
          pricingRecommendationJobLaneCount: 1,
          pricingRecommendationJobWorkflowMaxActiveClaims: 1,
          pricingRecommendationJobMaxActiveClaimsPerJob: 1,
          pricingBulkRepriceJobLaneCount: 1,
          pricingBulkRepriceJobWorkflowMaxActiveClaims: 1,
          pricingBulkRepriceJobMaxActiveClaimsPerJob: 1,
          pricingRepricingEvaluationJobLaneCount: 1,
          pricingRepricingDryRunJobLaneCount: 1,
        },
        logger: { info() {}, warn() {}, error() {} },
      });
      await runners[0]!.runOnce();
      expect(await lookupListingBatch(eventStore, batch)).toMatchObject({ items: [{ outcome: "succeeded" }] });
      expect(appends).toBe(1);
      const [fact] = await eventStore.readStream({ streamId: listingBatchStreamId(batch) });
      expect(fact).toMatchObject({
        tenantId: "tnt_identity",
        performedByUserId: "usr_identity_system",
        forAccountId: batch.accountId,
      });
    },
  );
});
