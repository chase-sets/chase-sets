import type { LoaderFunctionArgs } from "react-router";
import type { ProviderRefreshSchedulePanelItem } from "../../../features/provider-scope-discovery/ui/provider-refresh-schedule-panel";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { loadHealthSurface } from "./integrations-loader-support";

// Provider detail page loader (/catalog/providers/:providerKey, v2 IA). The
// route carries providerKey as a path param (there is no ?section= workspace
// router in the v2 contract), but the read-model composition below it
// (parseCatalogPrimaryWorkbenchRouteContext) still only understands providerKey
// as a query param, so this loader seeds the query string from the path param
// before delegating. A ?providerKey= override in the incoming URL — used by a
// handful of existing fixtures/tests — still wins if present, matching the
// prior provider-scoped surfaces' precedence.
//
// The "health" surface composition is reused verbatim (not duplicated) because it
// is the one surface that already computes every slice this page renders in one
// pass: profileAuthoring, validationReadiness (with the real authoring model),
// lifecycleRecovery (with real rollback/deprecate/retire impact evidence), and
// healthTriage (provider credential/transport readiness) — see
// buildCatalogPrimaryWorkbenchReadModelForSurface's "health computes everything"
// contract in primary-workbench-read-model-composition.ts.
export async function loadProviderDetail(args: LoaderFunctionArgs) {
  const providerKey = routeParamProviderKey(args);
  const url = new URL(args.request.url);
  if (providerKey && !url.searchParams.get("providerKey")) {
    url.searchParams.set("providerKey", providerKey);
  }
  const request =
    url.toString() === args.request.url
      ? args.request
      : new Request(url.toString(), { method: "GET", headers: args.request.headers });

  const [surfaceData, providerRefreshSchedules] = await Promise.all([
    loadHealthSurface({ ...args, request }),
    loadProviderRefreshSchedules(request, providerKey),
  ]);

  return { ...surfaceData, providerRefreshSchedules };
}

async function loadProviderRefreshSchedules(
  request: Request,
  providerKey: string | null,
): Promise<readonly ProviderRefreshSchedulePanelItem[] | null> {
  if (!providerKey) {
    return [];
  }

  const api = createCatalogRequestApiClient(request);
  if (typeof api.listCatalogProviderRefreshSchedules !== "function") {
    return null;
  }

  try {
    const response = await api.listCatalogProviderRefreshSchedules<{
      items: readonly ProviderRefreshSchedulePanelItem[];
    }>();
    return response.items.filter((schedule) => schedule.providerKey === providerKey);
  } catch {
    return null;
  }
}

function routeParamProviderKey(args: LoaderFunctionArgs): string | null {
  const value = args.params.providerKey;
  return typeof value === "string" && value.trim() ? value : null;
}
