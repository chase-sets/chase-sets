import type {
  CatalogProviderProfileVersionReview,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
} from "../../../client";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchActionReadModel } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import type { SourceObservationIntegrationJobScope } from "../../../features/source-observations/ui/contracts";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import { stringValue } from "./integrations-form-values";

export type CatalogPrimaryWorkbenchFormIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "clone-provider-profile"
  | "activate-provider-profile"
  | "rollback-provider-profile"
  | "deprecate-provider-profile"
  | "retire-provider-profile"
  | "update-provider-profile-section"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "start-reapply"
  | "start-replay"
>;

export type CatalogCommandJobResponse = Readonly<{
  jobId?: unknown;
  status?: unknown;
  progress?: unknown;
}>;

type RouteContext = ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;

export function commandContextFromFormData(requestUrl: string, formData: FormData) {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(requestUrl);
  const selectedObservationIds = observationIdsFromFormData(formData, parsedContext.selectedObservationIds);

  return {
    ...parsedContext,
    providerKey: stringValue(formData.get("providerKey")) ?? parsedContext.providerKey,
    unitKey: (stringValue(formData.get("unitKey")) ?? parsedContext.unitKey) as typeof parsedContext.unitKey,
    importScope: stringValue(formData.get("importScope")) ?? parsedContext.importScope,
    profileVersion: stringValue(formData.get("profileVersion")) ?? parsedContext.profileVersion,
    selectedObservationIds,
    jobId: stringValue(formData.get("jobId")) ?? parsedContext.jobId,
    promotionPreviewId: stringValue(formData.get("promotionPreviewId")) ?? parsedContext.promotionPreviewId,
  };
}

export function observationIdsFromFormData(formData: FormData, fallback: readonly string[]): readonly string[] {
  const values = String(formData.get("selectedObservationIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? [...new Set(values)] : fallback;
}

export function integrationScopeFromContext(context: RouteContext): SourceObservationIntegrationJobScope {
  const [language, productLineId, seriesId, setId] = context.importScope?.split(":") ?? [];

  return compactScope({
    provider: context.providerKey ?? undefined,
    language: context.sourceObservationFilters.language ?? language,
    seriesId,
    setId: context.sourceObservationFilters.setId ?? setId,
    productLineId,
  });
}

export function promotionScopeFromContext(context: RouteContext): SourceObservationPromotionScope {
  const [language, , , setId] = context.importScope?.split(":") ?? [];

  return compactScope({
    provider: context.providerKey ?? undefined,
    language: context.sourceObservationFilters.language ?? language,
    setId: context.sourceObservationFilters.setId ?? setId,
    status: context.sourceObservationFilters.status ?? "changed",
    search: context.sourceObservationFilters.search,
  });
}

export function reapplyScopeFromContext(context: RouteContext): SourceObservationPromotionScope {
  return {
    ...promotionScopeFromContext(context),
    status: context.sourceObservationFilters.status ?? "promoted",
  };
}

export function promotionPreviewIdFor(
  preview: SourceObservationPromotionPreview,
  context: RouteContext,
  selectedObservationIds: readonly string[],
): string {
  return [
    "preview",
    promotionPreviewScopeToken(context, selectedObservationIds),
    preview.matched,
    preview.eligible,
  ].join("-");
}

export async function confirmsFreshPromotionPreview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: RouteContext,
  selectedObservationIds: readonly string[],
): Promise<boolean> {
  const preview = await previewPromotionForContext(api, context, selectedObservationIds);
  const expectedPreviewId = promotionPreviewIdFor(preview, context, selectedObservationIds);

  return context.promotionPreviewId === expectedPreviewId;
}

export async function previewPromotionForContext(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: RouteContext,
  selectedObservationIds: readonly string[],
): Promise<SourceObservationPromotionPreview> {
  return selectedObservationIds.length > 0
    ? api.previewBulkPromoteSourceObservationIds<SourceObservationPromotionPreview>([...selectedObservationIds])
    : api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(promotionScopeFromContext(context));
}

export async function runProviderProfileLifecycleCommand(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  intent: Extract<
    CatalogPrimaryWorkbenchFormIntent,
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
  providerKey: string,
  profileVersion: string,
): Promise<CatalogProviderProfileVersionReview> {
  if (intent === "rollback-provider-profile") {
    return api.rollbackSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
      providerKey,
      profileVersion,
    );
  }
  if (intent === "deprecate-provider-profile") {
    return api.deprecateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
      providerKey,
      profileVersion,
    );
  }

  return api.retireSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(providerKey, profileVersion);
}

export function lifecycleConfirmationAccepted(
  formData: FormData,
  intent: Extract<
    CatalogPrimaryWorkbenchFormIntent,
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
  providerKey: string,
  profileVersion: string,
): boolean {
  return (
    stringValue(formData.get("lifecycleConfirmation")) ===
    lifecycleConfirmationValue(intent, providerKey, profileVersion)
  );
}

function lifecycleConfirmationValue(
  intent: Extract<
    CatalogPrimaryWorkbenchFormIntent,
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
  providerKey: string,
  profileVersion: string,
): string {
  return `confirm:${intent}:${providerKey}:${profileVersion}`;
}

export function lifecycleSuccessResult(
  intent: Extract<
    CatalogPrimaryWorkbenchFormIntent,
    "rollback-provider-profile" | "deprecate-provider-profile" | "retire-provider-profile"
  >,
): Extract<
  CatalogPrimaryWorkbenchCommandFeedback["result"],
  "profile-rolled-back" | "profile-deprecated" | "profile-retired"
> {
  if (intent === "rollback-provider-profile") {
    return "profile-rolled-back";
  }
  if (intent === "deprecate-provider-profile") {
    return "profile-deprecated";
  }

  return "profile-retired";
}

export function lifecycleFailureResult(
  error: unknown,
): Extract<CatalogPrimaryWorkbenchCommandFeedback["result"], "lifecycle-conflict" | "command-failed"> {
  if (error instanceof CatalogApiError && error.status === 409) {
    return "lifecycle-conflict";
  }

  return "command-failed";
}

function promotionPreviewScopeToken(context: RouteContext, selectedObservationIds: readonly string[]): string {
  const scope = promotionScopeFromContext(context);

  return [
    scope.provider ?? "all",
    context.unitKey ?? "none",
    context.importScope ?? "none",
    context.profileVersion ?? "none",
    scope.language ?? "all",
    scope.setId ?? "all",
    scope.status ?? "all",
    scope.search ?? "none",
    selectedObservationIds.join(".") || "filtered",
  ]
    .map(tokenSegment)
    .join("_");
}

function tokenSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_") || "none";
}

function compactScope<T extends Record<string, string | undefined>>(scope: T): T {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => value)) as T;
}
