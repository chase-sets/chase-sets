import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { createPublicMarketplaceSalesFeeScheduleRoutes } from "./route";

describe("published marketplace sales fee schedule route", () => {
  it("publishes the resolved canonical schedule without authentication", async () => {
    const resolvePolicy: CommercialTermsPolicyRuntime["resolvePolicy"] = vi.fn(async (definition) => ({
      policyKey: definition.policyKey,
      value: definition.defaultValue,
      source: "policy" as const,
      documentId: "pol_standard",
      effectiveFrom: "2026-07-03T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-12T00:00:00.000Z",
    }));
    const app = new Hono<CommercialTermsApiEnv>();
    app.route("/", createPublicMarketplaceSalesFeeScheduleRoutes({ resolvePolicy }));

    const response = await app.request("/marketplace-sales-fee-schedule");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
      source: "policy",
      documentId: "pol_standard",
    });
  });
});
