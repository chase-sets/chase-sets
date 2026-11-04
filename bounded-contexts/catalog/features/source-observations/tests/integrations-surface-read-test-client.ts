import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  CatalogSourceOptionQueryRefusedError,
  readCatalogPrimaryWorkbenchDeferredSourceOptions,
  readCatalogPrimaryWorkbenchSurface,
  type CatalogPrimaryWorkbenchSurfaceKey,
  type CatalogPrimaryWorkbenchSurfaceSources,
} from "../api/admin/primary-workbench-surface-read";
import { ApiError as CatalogApiError } from "../../../support/shell-support/api/client";

// Test-only. The integrations loaders read their workbench from the Catalog
// API's surface endpoints. Loader tests stub the per-projection client methods
// (scopes, profiles, overview, review, options, ...); this wraps such a stub so
// the two surface endpoints answer with the real API-side composition over those
// same stubs, round-tripped through JSON like an HTTP response. The HTTP route
// itself is covered by the source-observations route tests.

type StubMethod = (...args: readonly unknown[]) => Promise<unknown>;
type StubClient = Readonly<Record<string, unknown>>;

const LOCATION_ORIGIN = "https://admin.example";

export function withCatalogSurfaceReads<T>(client: T, request?: Request): T {
  if (typeof client !== "object" || client === null) {
    return client;
  }
  const stub = client as StubClient;
  const sources = async (location: URL) => stubSurfaceSources(stub, await canManageCatalog(request ?? location));

  return {
    ...stub,
    getCatalogPrimaryWorkbenchSurface:
      stub.getCatalogPrimaryWorkbenchSurface ??
      (async (surface: CatalogPrimaryWorkbenchSurfaceKey, location: string) => {
        const url = new URL(location, LOCATION_ORIGIN);
        return wireShape(await readCatalogPrimaryWorkbenchSurface(surface, url, await sources(url)));
      }),
    getCatalogPrimaryWorkbenchDeferredSourceOptions:
      stub.getCatalogPrimaryWorkbenchDeferredSourceOptions ??
      (async (location: string) => {
        const url = new URL(location, LOCATION_ORIGIN);
        return wireShape(await readCatalogPrimaryWorkbenchDeferredSourceOptions(url, await sources(url)));
      }),
  } as T;
}

// The API reads catalog.manage from its own actor; under test that actor is the
// one the (mocked) auth resolver returns for the request.
async function canManageCatalog(source: Request | URL): Promise<boolean> {
  try {
    const request = source instanceof Request ? source : new Request(source);
    const actor = await resolveActorFromAuthApi({ request });
    return actor?.permissions.includes("catalog.manage") ?? false;
  } catch {
    return false;
  }
}

function stubSurfaceSources(stub: StubClient, canManage: boolean): CatalogPrimaryWorkbenchSurfaceSources {
  const call = <R>(name: string, ...args: readonly unknown[]): Promise<R> => {
    const method = stub[name];
    if (typeof method !== "function") {
      return Promise.reject(new Error(`Synthetic Catalog client has no ${name}.`));
    }
    return (method as StubMethod)(...args) as Promise<R>;
  };

  return {
    canManageCatalog: canManage,
    listIntegrationScopes: (filter) =>
      call("listSourceObservationIntegrationScopes", new URLSearchParams(filter).toString()),
    listProviderProfiles: () => call("listSourceObservationProviderProfiles"),
    getControlPlaneOverview: (audience) => call("getCatalogIntegrationControlPlaneOverview", audience),
    listSourceObservations: (query) => call("listSourceObservations", query),
    listMergeCandidates: (query) => call("listCatalogMergeCandidates", query),
    getPromotionOutcome: async (jobId) =>
      (
        await call<{ outcome?: Awaited<ReturnType<CatalogPrimaryWorkbenchSurfaceSources["getPromotionOutcome"]>> }>(
          "getSourceObservationPromotionOutcome",
          jobId,
        )
      ).outcome ?? null,
    previewPromotion: ({ observationIds, scope, promoteAsDraft }) =>
      observationIds.length > 0
        ? call("previewBulkPromoteSourceObservationIds", [...observationIds], { promoteAsDraft })
        : call("previewBulkPromoteSourceObservations", scope, { promoteAsDraft }),
    getProviderProfileAuthoringModel: async (providerKey, profileVersion) => {
      try {
        return await call("getSourceObservationProviderProfileAuthoringModel", providerKey, profileVersion);
      } catch (error) {
        if (error instanceof CatalogApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    getProviderProfileLifecycleImpact: (providerKey, profileVersion, operation) =>
      call("getSourceObservationProviderProfileLifecycleImpact", providerKey, profileVersion, operation),
    queryIntegrationOptions: async (query) => {
      try {
        return await call("listSourceObservationIntegrationOptions", query);
      } catch (error) {
        if (error instanceof CatalogApiError) {
          throw new CatalogSourceOptionQueryRefusedError(error.status, error.body);
        }
        throw error;
      }
    },
    previewCatalogSyncScope: (scope) => call("previewCatalogSyncScope", scope),
  };
}

function wireShape(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
