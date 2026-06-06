import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type {
  CatalogIntegrationEngineServices,
  ProviderOptionQueryServices,
  SourceObservationReadServices,
} from "./runtime";

export type ProviderOptionRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  Pick<CatalogIntegrationEngineServices, "getCatalogIntegrationControlPlaneReadiness">;

export function providerOptionRoutes(services: ProviderOptionRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/integration-scopes", async (c) => {
    const { provider, source, language, setId, expansionId } = c.req.query();
    const items = await services.listIntegrationScopes({
      provider: provider ?? source,
      language,
      setId: expansionId ?? setId,
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-options", async (c) => {
    const items = await services.listIntegrationOptions({
      providerKey: String(c.req.query("providerKey") ?? c.req.query("provider") ?? "tcgdex"),
      queryKind: String(c.req.query("queryKind") ?? c.req.query("kind") ?? ""),
      languageCode: c.req.query("languageCode") ?? c.req.query("language"),
      parentValue: c.req.query("parentValue") ?? c.req.query("seriesId") ?? c.req.query("series"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-control-plane/readiness", async (c) => {
    const result = await services.getCatalogIntegrationControlPlaneReadiness();
    return c.json(result);
  });

  return app;
}
