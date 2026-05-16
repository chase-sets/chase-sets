import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { sourceObservationRoutes } from "./route";
import type { SourceObservationServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

function buildApp(services: SourceObservationServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.use("/source-observations/*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/source-observations", sourceObservationRoutes(services));

  return app;
}

describe("source observation routes", () => {
  it("bulk promotes the explicit observation ids from the request body", async () => {
    const promoteObservations = vi.fn(async () => ({
      requested: 2,
      promoted: 1,
      skipped: 1,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_1",
          status: "promoted" as const,
          catalogItemId: "cat_1" as never,
          reason: null,
        },
        {
          observationId: "obs_2",
          status: "skipped" as const,
          catalogItemId: "cat_existing" as never,
          reason: "Source observation is already promoted.",
        },
      ],
    }));
    const services = {
      promoteObservations,
    } as unknown as SourceObservationServices;
    const app = buildApp(services);

    const response = await app.request("/source-observations/bulk-promote", {
      method: "POST",
      body: JSON.stringify({ observationIds: ["obs_1", "obs_2"] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requested: 2,
      promoted: 1,
      skipped: 1,
      failed: 0,
    });
    expect(promoteObservations).toHaveBeenCalledWith({
      observationIds: ["obs_1", "obs_2"],
      context,
    });
  });
});
