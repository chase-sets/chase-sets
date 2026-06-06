import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { PromotionReapplyServices } from "./runtime";
import { parsePromotionScope } from "./route-helpers";

export type PromotionReviewRouteServices = Pick<
  PromotionReapplyServices,
  "previewPromoteObservationScope" | "previewReapplyObservationScope"
>;

export function promotionReviewRoutes(services: PromotionReviewRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/bulk-promote/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewPromoteObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  app.post("/reapply/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewReapplyObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  return app;
}
