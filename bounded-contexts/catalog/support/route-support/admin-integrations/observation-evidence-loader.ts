import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import type { SourceObservationDetail } from "../../../client";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { sourceObservationEvidenceDetailFor } from "../../../features/source-observations/ui/primary-workbench-source-observation-review";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";

// The shape the evidence SideSheet fetcher consumes (#1971). Re-exported from the
// feature contract so the route module's data type is the canonical one.
export type CatalogSourceObservationEvidenceRouteData = CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData;

// Lazy evidence endpoint for the Source Observation review SideSheet (#1971). The
// review list ships slim rows; when an operator opens a row's evidence sheet, the
// sheet's useFetcher hits this resource route keyed by observationId. It fetches
// the single Source Observation and composes the exact deep evidence detail the
// row used to carry inline — so the sheet shows the same facts/duplicates/
// conflicts/audit and provenance, only fetched on demand instead of for every row.
//
// canManage gates promotion readiness identically to the review composer; we read
// it from the same auth API the daily loader uses. A missing observation (404) or
// a transient failure resolves to a null detail (not a thrown boundary), so the
// sheet renders its error fallback rather than an error page.
export async function loadSourceObservationEvidence({
  request,
  params,
}: LoaderFunctionArgs): Promise<CatalogSourceObservationEvidenceRouteData> {
  const observationId = params.id ?? "";
  if (!observationId) {
    return { observationId, detail: null };
  }

  const api = createCatalogRequestApiClient(request);
  try {
    const [observation, actor] = await Promise.all([
      api.getSourceObservation<SourceObservationDetail>(observationId),
      resolveActorFromAuthApi({ request }),
    ]);
    const canManage = actor?.permissions.includes("catalog.manage") ?? false;

    return {
      observationId,
      detail: sourceObservationEvidenceDetailFor(observation, { canManage }),
    };
  } catch (error) {
    if (error instanceof CatalogApiError && error.status === 404) {
      return { observationId, detail: null };
    }
    throw error;
  }
}
