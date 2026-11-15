import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { createDurableJobLaneRunners, type WorkerRunner } from "@chase-sets/platform-runtime/worker";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { MarketplaceListingServices } from "./runtime";
import type { PricingRecommendationServices } from "@chase-sets/pricing/server";
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
      const processNext: PricingRecommendationServices["processNextRecommendationJob"] = async (input) => {
        const gateway = input.marketplaceListingGatewayForAccount!(batch.accountId);
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
      const text = readFileSync(
        new URL("../../../../../deployables/platform-worker/src/main.ts", import.meta.url),
        "utf8",
      );
      const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
      const name = kind === "bulk-reprice" ? "createBulkRepriceIngestionJobRunners" : "createPricingJobRunners";
      const declarations = source.statements.filter(
        (node) =>
          (ts.isFunctionDeclaration(node) && (node.name?.text === name || node.name?.text === "sellerSystemContext")) ||
          (ts.isVariableStatement(node) &&
            node.declarationList.declarations.some((decl) => decl.name.getText(source) === "SYSTEM_CONTEXT")),
      );
      const compiled = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      const services = {
        marketplace: { listings },
        inventory: { importBatches: {} },
        pricing: {
          recommendations: kind === "recommendation" ? { processNextRecommendationJob: processNext } : undefined,
          bulkRepriceIngestion: { processNextBulkRepriceJob: processNext },
          repricingEngine: kind === "evaluation" ? { processNextEvaluationJob: () => 1 } : undefined,
        },
      };
      const runners: readonly WorkerRunner[] = runInNewContext(compiled + `\n${name}(services, config)`, {
        services,
        createDurableJobLaneRunners,
        config: {
          workerId: "synthetic-worker",
          leaseTtlMs: 1000,
          pricingRecommendationJobLaneCount: 1,
          pricingBulkRepriceJobLaneCount: 1,
          pricingRepricingEvaluationJobLaneCount: 1,
        },
        logger: {},
        processRepricingEvaluationJob: async (
          _next: unknown,
          input: { marketplaceGatewayForAccount: (accountId: string) => unknown },
        ) =>
          processNext({ marketplaceListingGatewayForAccount: input.marketplaceGatewayForAccount } as Parameters<
            typeof processNext
          >[0]),
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
