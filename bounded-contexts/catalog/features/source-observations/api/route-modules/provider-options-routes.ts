import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type {
  CatalogIntegrationEngineServices,
  ProviderOptionQueryServices,
  SourceObservationReadServices,
} from "../runtime";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "../governance/catalog-integration-rollout-controls";
import { CatalogProviderOptionQueryUnavailableError } from "../providers/provider-option-query-cache";
import { CatalogProviderOptionQueryInvalidRequestError } from "../providers/provider-option-query-resolver";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type ProviderOptionRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  Pick<CatalogIntegrationEngineServices, "getCatalogIntegrationControlPlaneReadiness">;

export type IntegrationOptionQueryInput = Parameters<ProviderOptionQueryServices["queryIntegrationOptions"]>[0];

// The `GET /integration-options` query, parsed once so the HTTP route and the
// in-process workbench surface read resolve options with the same semantics.
export function integrationOptionQueryFromParams(
  query: Readonly<Record<string, string | undefined>>,
): IntegrationOptionQueryInput {
  const cacheOnly = query.cacheOnly === "true";
  return {
    providerKey: String(query.providerKey ?? query.provider ?? "tcgdex"),
    profileKey: query.profileKey,
    ingestionUnitKey: query.ingestionUnitKey ?? query.unitKey,
    queryKind: String(query.queryKind ?? query.kind ?? ""),
    languageCode: query.languageCode ?? query.language,
    parentValue: query.parentValue ?? query.seriesId ?? query.series,
    cursor: query.cursor,
    limit: positiveIntegerQueryValue(query.limit),
    forceRefresh: query.forceRefresh === "true",
    ...(cacheOnly ? { cacheOnly } : {}),
  };
}

export type IntegrationOptionPage = Readonly<{
  items: readonly unknown[];
  total: number;
  count: number;
}> &
  Readonly<Record<string, unknown>>;

export async function resolveIntegrationOptionPage(
  services: ProviderOptionQueryServices,
  input: IntegrationOptionQueryInput,
): Promise<IntegrationOptionPage> {
  if (typeof services.queryIntegrationOptions === "function") {
    return (await services.queryIntegrationOptions(input)) as unknown as IntegrationOptionPage;
  }

  const items = await services.listIntegrationOptions({
    providerKey: input.providerKey,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
    queryKind: input.queryKind,
    languageCode: input.languageCode,
    parentValue: input.parentValue,
  });
  return { items, total: items.length, count: items.length };
}

// The documented refusals of an option query and the status each one answers
// with. Anything else is an unexpected failure the caller rethrows.
export function integrationOptionQueryRefusal(
  error: unknown,
): Readonly<{ status: 400 | 403 | 503; body: Readonly<{ error: Readonly<Record<string, unknown>> }> }> | null {
  if (error instanceof CatalogIntegrationRolloutControlError) {
    return { status: 403, body: rolloutControlErrorResponse(error) };
  }
  if (error instanceof CatalogProviderOptionQueryUnavailableError) {
    return { status: 503, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof CatalogProviderOptionQueryInvalidRequestError) {
    return { status: 400, body: { error: { code: error.code, message: error.message } } };
  }
  return null;
}

export function providerOptionRoutes(services: ProviderOptionRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/integration-scopes", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    const { provider, source, language, productLineId, seriesId, setId, expansionId } = c.req.query();
    const items = await services.listIntegrationScopes({
      provider: provider ?? source,
      language,
      ...(productLineId ? { productLineId } : {}),
      ...(seriesId ? { seriesId } : {}),
      ...(expansionId ? { expansionId } : {}),
      setId: expansionId ?? setId,
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-options", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    try {
      return c.json(await resolveIntegrationOptionPage(services, integrationOptionQueryFromParams(c.req.query())));
    } catch (error) {
      const refusal = integrationOptionQueryRefusal(error);
      if (refusal) {
        return c.json(refusal.body, refusal.status);
      }
      throw error;
    }
  });

  app.get("/integration-control-plane/readiness", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }

    const result = await services.getCatalogIntegrationControlPlaneReadiness();
    return c.json(result);
  });

  return app;
}

function positiveIntegerQueryValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
