import { Hono } from "hono";
import type { CommercialTermsApiEnv } from "../../../api";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { marketplaceSalesFeeSchedulePolicy } from "../domain/policy";

export function createPublicMarketplaceSalesFeeScheduleRoutes(
  policies: Pick<CommercialTermsPolicyRuntime, "resolvePolicy">,
) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.get("/marketplace-sales-fee-schedule", async (c) => {
    const resolved = await policies.resolvePolicy(marketplaceSalesFeeSchedulePolicy);
    return c.json({
      value: resolved.value,
      source: resolved.source,
      documentId: resolved.documentId,
      effectiveFrom: resolved.effectiveFrom,
      resolvedAt: resolved.resolvedAt,
    });
  });

  return app;
}
