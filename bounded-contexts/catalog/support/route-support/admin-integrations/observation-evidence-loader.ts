import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs } from "react-router";
import type { SourceObservationDetail } from "../../../client";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import {
  sourceObservationEvidenceDetailFor,
  type ProductContentsEvidenceConfig,
} from "../../../features/source-observations/ui/primary-workbench-source-observation-review";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";

// The shape the evidence SideSheet fetcher consumes. Re-exported from the
// feature contract so the route module's data type is the canonical one.
export type CatalogSourceObservationEvidenceRouteData = CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData;

// Lazy evidence endpoint for the Source Observation review SideSheet. The
// review list ships slim rows; when an operator opens a row's evidence sheet, the
// sheet's useFetcher hits this resource route keyed by observationId. It fetches
// the single Source Observation and composes the exact deep evidence detail
// matching the review row's inline evidence shape — so the sheet shows the same
// facts/duplicates/conflicts/audit and provenance, only fetched on demand instead
// of for every row.
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
    const [observation, actor, productContentsConfig] = await Promise.all([
      api.getSourceObservation<SourceObservationDetail>(observationId),
      resolveActorFromAuthApi({ request }),
      loadProductContentsEvidenceConfig(api).catch(() => ({})),
    ]);
    const canManage = actor?.permissions.includes("catalog.manage") ?? false;

    return {
      observationId,
      detail: sourceObservationEvidenceDetailFor(observation, { canManage, productContentsConfig }),
    };
  } catch (error) {
    if (error instanceof CatalogApiError && error.status === 404) {
      return { observationId, detail: null };
    }
    throw error;
  }
}

type ProductContentTypeConfigRow = Readonly<{
  content_type_id: string;
  key: string;
  display_name: unknown;
}>;

type ProductContentInclusionPolicyConfigRow = Readonly<{
  inclusion_policy_id: string;
  key: string;
  display_name: unknown;
}>;

async function loadProductContentsEvidenceConfig(
  api: ReturnType<typeof createCatalogRequestApiClient>,
): Promise<ProductContentsEvidenceConfig> {
  const [types, policies] = await Promise.all([
    api.listProductContentTypes<ListResponse<ProductContentTypeConfigRow>>(),
    api.listProductContentInclusionPolicies<ListResponse<ProductContentInclusionPolicyConfigRow>>(),
  ]);

  return {
    contentTypeLabelsById: new Map(
      types.items.map((type) => [type.content_type_id, localizedDisplayName(type.display_name) || type.key]),
    ),
    inclusionPolicyLabelsById: new Map(
      policies.items.map((policy) => [
        policy.inclusion_policy_id,
        localizedDisplayName(policy.display_name) || policy.key,
      ]),
    ),
  };
}

function localizedDisplayName(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const values = isRecord(value.values) ? value.values : {};
  const defaultLocale = typeof value.defaultLocale === "string" ? value.defaultLocale : "en";
  return String(values.en ?? values[defaultLocale] ?? Object.values(values)[0] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
