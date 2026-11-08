import type { LoaderFunctionArgs } from "react-router";
import type { CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";

// The shape the evidence SideSheet fetcher consumes. Re-exported from the
// feature contract so the route module's data type is the canonical one.
export type CatalogSourceObservationEvidenceRouteData = CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData;

// Lazy evidence endpoint for the Source Observation review SideSheet. The
// review list ships slim rows; when an operator opens a row's evidence sheet, the
// sheet's useFetcher hits this resource route keyed by observationId, which
// forwards the Catalog API's evidence read (GET /source-observations/:id/evidence).
// The API composes the detail, including promotion readiness for this actor.
//
// A missing observation (404) or a failed read resolves to a null detail (not a
// thrown boundary), so the sheet renders its error fallback rather than an error page.
export async function loadSourceObservationEvidence({
  request,
  params,
}: LoaderFunctionArgs): Promise<CatalogSourceObservationEvidenceRouteData> {
  const observationId = params.id ?? "";
  if (!observationId) {
    return { observationId, detail: null };
  }

  try {
    return await createCatalogRequestApiClient(
      request,
    ).getSourceObservationEvidence<CatalogSourceObservationEvidenceRouteData>(observationId);
  } catch {
    return { observationId, detail: null };
  }
}
