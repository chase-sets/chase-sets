import type {
  CatalogProviderProfileVersionReview,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
} from "../../../client";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchActionReadModel } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import type {
  CatalogSyncScope,
  CatalogSyncScopeReferenceKind,
  SourceObservationIntegrationJobScope,
} from "../../../features/source-observations/ui/contracts";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import {
  importScopeFromScopeContext,
  scopeContextFromFormData,
  scopeContextFromRouteContext,
  scopeContextToIntegrationJobScope,
  scopeContextToObservationFilterScope,
} from "../../../features/source-observations/ui/primary-workbench-scope-context";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import { stringValue } from "./integrations-form-values";

export type CatalogPrimaryWorkbenchFormIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-provider-import"
  | "start-catalog-sync"
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
  const providerKey = stringValue(formData.get("providerKey")) ?? parsedContext.providerKey;
  const importScope = formData.has("importScope")
    ? stringValue(formData.get("importScope"))
    : parsedContext.importScope;
  const baseScope = scopeContextFromRouteContext({ ...parsedContext, providerKey, importScope });
  const scope = clearExplicitEmptyScopeFields(scopeContextFromFormData(formData, baseScope), formData);

  return {
    ...parsedContext,
    providerKey,
    unitKey: (stringValue(formData.get("unitKey")) ?? parsedContext.unitKey) as typeof parsedContext.unitKey,
    scope,
    importScope: importScopeFromScopeContext(scope) ?? importScope,
    profileVersion: stringValue(formData.get("profileVersion")) ?? parsedContext.profileVersion,
    selectedObservationIds,
    jobId: stringValue(formData.get("jobId")) ?? parsedContext.jobId,
    promotionPreviewId: stringValue(formData.get("promotionPreviewId")) ?? parsedContext.promotionPreviewId,
  };
}

function clearExplicitEmptyScopeFields(
  scope: ReturnType<typeof scopeContextFromFormData>,
  formData: FormData,
): ReturnType<typeof scopeContextFromFormData> {
  return {
    ...scope,
    languageCode: explicitEmptyScopeField(formData, ["languageCode", "language"]) ? null : scope.languageCode,
    productLineId: explicitEmptyScopeField(formData, ["productLineId"]) ? null : scope.productLineId,
    productLineName: explicitEmptyScopeField(formData, ["productLineName"]) ? null : scope.productLineName,
    seriesId: explicitEmptyScopeField(formData, ["seriesId"]) ? null : scope.seriesId,
    seriesName: explicitEmptyScopeField(formData, ["seriesName"]) ? null : scope.seriesName,
    expansionId: explicitEmptyScopeField(formData, ["expansionId", "setId"]) ? null : scope.expansionId,
    expansionName: explicitEmptyScopeField(formData, ["expansionName", "setName"]) ? null : scope.expansionName,
    status: explicitEmptyScopeField(formData, ["status"]) ? null : scope.status,
  };
}

function explicitEmptyScopeField(formData: FormData, names: readonly string[]): boolean {
  const presentNames = names.filter((name) => formData.has(name));
  if (presentNames.length === 0) {
    return false;
  }

  return presentNames.every((name) => !stringValue(formData.get(name)));
}

export function observationIdsFromFormData(formData: FormData, fallback: readonly string[]): readonly string[] {
  const values = String(formData.get("selectedObservationIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? [...new Set(values)] : fallback;
}

export function integrationScopeFromContext(context: RouteContext): SourceObservationIntegrationJobScope {
  const scope = context.scope ?? scopeContextFromRouteContext(context);
  return scopeContextToIntegrationJobScope({
    ...scope,
    ingestionUnitKey: context.unitKey ?? undefined,
    languageCode: context.sourceObservationFilters.language ?? scope.languageCode,
    expansionId:
      context.sourceObservationFilters.setId ?? context.sourceObservationFilters.expansionId ?? scope.expansionId,
  });
}

export function catalogSyncScopeFromContext(context: RouteContext, formData: FormData): CatalogSyncScope | null {
  const scope = scopeContextFromRouteContext(context);
  const productDomain = stringValue(formData.get("productDomain"));
  const productForm = stringValue(formData.get("productForm"));
  const languageCode = stringValue(formData.get("languageCode")) ?? scope.languageCode;
  const selectedUnitKeys = formData
    .getAll("selectedUnitKeys")
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value));
  const excludedUnitKeys = formData
    .getAll("excludedUnitKeys")
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value));
  const reference = catalogSyncReferenceFromContext(context, formData);

  if (!productDomain || !productForm || !languageCode || !reference) {
    return null;
  }

  return {
    scopeVersion: "catalog-sync-scope-v1",
    productDomain,
    productForm,
    languageCode,
    reference,
    providerParticipation: {
      requiredUnitKeys: [],
      selectedUnitKeys: [...new Set(selectedUnitKeys)],
      excludedUnitKeys: [...new Set(excludedUnitKeys)],
    },
  };
}

export function promotionScopeFromContext(context: RouteContext): SourceObservationPromotionScope {
  return scopeContextToObservationFilterScope(scopeContextFromRouteContext(context), context.sourceObservationFilters);
}

export function hasExplicitPromotionScope(context: RouteContext): boolean {
  const scope = scopeContextFromRouteContext(context);

  return Boolean(context.providerKey && context.unitKey && importScopeFromScopeContext(scope));
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

function catalogSyncReferenceFromContext(
  context: RouteContext,
  formData: FormData,
): CatalogSyncScope["reference"] | null {
  const scope = scopeContextFromRouteContext(context);
  const kind = stringValue(formData.get("referenceKind")) as CatalogSyncScopeReferenceKind | null;
  const id =
    stringValue(formData.get("referenceId")) ??
    scope.expansionId ??
    scope.expansionName ??
    scope.seriesId ??
    scope.productLineId;
  if (!kind || !id) {
    return null;
  }

  return {
    kind,
    id,
    name:
      stringValue(formData.get("referenceName")) ?? scope.expansionName ?? scope.seriesName ?? scope.productLineName,
    seriesId: stringValue(formData.get("seriesId")) ?? scope.seriesId,
    seriesName: stringValue(formData.get("seriesName")) ?? scope.seriesName,
  };
}

function tokenSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_") || "none";
}
