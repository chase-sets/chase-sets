import { t } from "@chase-sets/localization";
import type { ProviderScopeDiscoveryServices } from "../../../provider-scope-discovery/api/runtime";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { CountSpend } from "../../../scope-sync-batches/domain/count-acquisition";
import type { SourceObservationRouteServices } from "../route";
import type { CatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import {
  CatalogProviderProfileVersionNotFoundError,
  getCatalogProviderProfileAuthoringModel,
  listCatalogProviderProfileVersionReviews,
} from "../providers/provider-profile-review";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";
import {
  CatalogSourceOptionQueryRefusedError,
  catalogPrimaryWorkbenchSurfaceKeys,
  readCatalogPrimaryWorkbenchDeferredSourceOptions,
  readCatalogPrimaryWorkbenchSurface,
  type CatalogPrimaryWorkbenchSurfaceKey,
  type CatalogPrimaryWorkbenchSurfaceSources,
} from "../admin/primary-workbench-surface-read";
import { loadCatalogIntegrationControlPlaneOverview } from "./control-plane-overview-load";
import { catalogMergeCandidateListParamsFromQuery } from "./catalog-merge-candidate-routes";
import {
  integrationOptionQueryFromParams,
  integrationOptionQueryRefusal,
  resolveIntegrationOptionPage,
} from "./provider-options-routes";
import { parseCatalogSyncScope, parseObservationIds, parsePromotionScope } from "./route-helpers";
import { sourceObservationListParamsFromRecord } from "./source-observation-review-routes";

// Admin route locations the workbench composes for. The read only ever rebuilds
// a Catalog admin location; it never follows the location anywhere.
const WORKBENCH_LOCATION_ORIGIN = "https://admin.example";
const WORKBENCH_LOCATION_PATH_PREFIX = "/catalog/";

export type PrimaryWorkbenchSurfaceRouteDeps = Readonly<{
  services: SourceObservationRouteServices;
  profileVersions?: CatalogProviderIntegrationProfileVersionStore;
  readCountSpend?: () => Promise<readonly CountSpend[]>;
  listRefreshSchedules?: ProviderScopeDiscoveryServices["listRefreshSchedules"];
}>;

// `GET /workbench-surfaces/:surface?location=<admin path and query>` returns the
// composed workbench read model for one audience surface, the projections it was
// built without, and the Catalog sync scope its selection names.
// `GET /workbench-surfaces/daily/source-options?location=...` returns the
// populated source-options slice the daily status panel streams.
export function primaryWorkbenchSurfaceRoutes(deps: PrimaryWorkbenchSurfaceRouteDeps) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/workbench-surfaces/daily/source-options", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }
    const location = workbenchLocation(c.req.query("location"));
    if (!location) {
      return invalidLocationResponse(c);
    }

    return c.json(await readCatalogPrimaryWorkbenchDeferredSourceOptions(location, surfaceSources(deps, c)));
  });

  app.get("/workbench-surfaces/:surface", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }
    const surface = workbenchSurfaceKey(c.req.param("surface"));
    if (!surface) {
      return c.json(
        {
          error: {
            code: "invalid_workbench_surface",
            message: t("catalog.features.sourceObservations.api.route.workbench.surface.invalid"),
          },
        },
        404,
      );
    }
    const location = workbenchLocation(c.req.query("location"));
    if (!location) {
      return invalidLocationResponse(c);
    }

    return c.json(await readCatalogPrimaryWorkbenchSurface(surface, location, surfaceSources(deps, c)));
  });

  return app;
}

function workbenchSurfaceKey(value: string): CatalogPrimaryWorkbenchSurfaceKey | null {
  return (catalogPrimaryWorkbenchSurfaceKeys as readonly string[]).includes(value)
    ? (value as CatalogPrimaryWorkbenchSurfaceKey)
    : null;
}

function workbenchLocation(value: string | undefined): URL | null {
  if (!value || !value.startsWith(WORKBENCH_LOCATION_PATH_PREFIX)) {
    return null;
  }
  try {
    const location = new URL(value, WORKBENCH_LOCATION_ORIGIN);
    return location.origin === WORKBENCH_LOCATION_ORIGIN && location.pathname.startsWith(WORKBENCH_LOCATION_PATH_PREFIX)
      ? location
      : null;
  } catch {
    return null;
  }
}

function invalidLocationResponse(c: Context<CatalogAuthoringEnv>) {
  return c.json(
    {
      error: {
        code: "invalid_workbench_location",
        message: t("catalog.features.sourceObservations.api.route.workbench.location.invalid"),
      },
    },
    400,
  );
}

// Bind the surface read to this request's actor, event-store context and the
// owning services, parsing each query exactly as its HTTP route does.
function surfaceSources(
  deps: PrimaryWorkbenchSurfaceRouteDeps,
  c: Context<CatalogAuthoringEnv>,
): CatalogPrimaryWorkbenchSurfaceSources {
  const { services, profileVersions, readCountSpend, listRefreshSchedules } = deps;
  const context = c.get("context");

  return {
    actor: c.get("actor"),
    listRefreshSchedules: listRefreshSchedules ? async () => wireShape(await listRefreshSchedules()) : undefined,
    canManageCatalog: c.get("actor")?.permissions.includes("catalog.manage") ?? false,
    listIntegrationScopes: async (filter) => {
      const items = await services.listIntegrationScopes({
        provider: filter.source,
        language: filter.language,
        setId: filter.setId,
      });
      return wireShape({ items, total: items.length, count: items.length });
    },
    listProviderProfiles: async () => {
      const items = profileVersions ? await listCatalogProviderProfileVersionReviews(profileVersions) : [];
      return wireShape({ items, total: items.length, count: items.length });
    },
    getControlPlaneOverview: async (audience) => {
      const providerSendWindow = (await services.getProviderSendWindow?.()) ?? { state: "unavailable" as const };
      return wireShape(
        await loadCatalogIntegrationControlPlaneOverview(
          { services, profileVersions, readCountSpend },
          { context, audience, providerSendWindow },
        ),
      );
    },
    listSourceObservations: async (query) => {
      const result = await services.listSourceObservations(sourceObservationListParamsFromRecord(queryRecord(query)));
      return wireShape({ items: result.items, total: result.total, count: result.items.length });
    },
    listMergeCandidates: async (query) =>
      wireShape(
        await services.listCatalogMergeCandidates(catalogMergeCandidateListParamsFromQuery(queryRecord(query))),
      ),
    getPromotionOutcome: async (jobId) => {
      const job = await services.getBulkReviewJob(jobId, context);
      if (!job || job.action !== "promote") {
        return null;
      }
      return wireShape(await services.getBulkReviewPromotionOutcome(jobId));
    },
    previewPromotion: async ({ observationIds, scope, promoteAsDraft }) => {
      const ids = parseObservationIds(observationIds);
      return wireShape(
        ids.length > 0
          ? await services.previewPromoteObservations({ observationIds: ids, promoteAsDraft, validationAfter: null })
          : await services.previewPromoteObservationScope({
              scope: parsePromotionScope(scope),
              promoteAsDraft,
              validationAfter: null,
            }),
      );
    },
    getProviderProfileAuthoringModel: async (providerKey, profileVersion) => {
      if (!profileVersions) {
        throw new Error(t("catalog.features.sourceObservations.api.route.profile.review.unavailable"));
      }
      try {
        return wireShape(
          await getCatalogProviderProfileAuthoringModel({
            store: profileVersions,
            providerKey,
            profileVersion,
            selectedOptionSchema: await services.getSelectedOptionAuthoringSchema(),
            promotionTargetSchema: await services.getPromotionTargetAuthoringSchema(),
          }),
        );
      } catch (error) {
        if (error instanceof CatalogProviderProfileVersionNotFoundError) {
          return null;
        }
        throw error;
      }
    },
    getProviderProfileLifecycleImpact: async (providerKey, profileVersion, operation) =>
      wireShape(
        await services.previewProviderProfileLifecycleImpact({ providerKey, profileVersion, operation, context }),
      ),
    queryIntegrationOptions: async (query) => {
      try {
        return wireShape(
          await resolveIntegrationOptionPage(services, integrationOptionQueryFromParams(queryRecord(query))),
        );
      } catch (error) {
        const refusal = integrationOptionQueryRefusal(error);
        if (refusal) {
          throw new CatalogSourceOptionQueryRefusedError(refusal.status, wireShape(refusal.body));
        }
        throw error;
      }
    },
    previewCatalogSyncScope: async (scope) =>
      wireShape(await services.previewCatalogSyncScope({ scope: parseCatalogSyncScope(scope), context })),
  };
}

// A query string as Hono's `c.req.query()` reads it: the first value of each key.
function queryRecord(query: string): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (!(key in record)) {
      record[key] = value;
    }
  }
  return record;
}

// The workbench composition consumes the records each HTTP route answers with.
// Passing an in-process result through JSON gives it exactly that shape (dates
// as strings, absent optionals dropped), so the surface read builds the same
// read model the admin loader built from those routes.
function wireShape<T>(value: unknown): T {
  return (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as T;
}
