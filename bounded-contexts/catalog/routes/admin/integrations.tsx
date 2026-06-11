import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useRouteLoaderData } from "react-router";
import { useMemo } from "react";
import { CatalogApiError } from "../../client";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
} from "../../client";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../features/source-observations/api/primary-workbench-admin-contracts";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileSectionUpdateCommand,
  CatalogIntegrationControlPlaneOverview,
  SourceObservationIntegrationJobScope,
} from "../../features/source-observations/ui/contracts";
import {
  commandTelemetryEvents,
  loaderTelemetryEvents,
  recordCatalogControlPlaneEvents,
  type CatalogControlPlaneTelemetryApi,
} from "../../features/source-observations/ui/primary-workbench-telemetry";
import { CatalogPrimaryWorkbenchPage } from "../../features/source-observations/ui/primary-workbench-page";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
} from "../../features/source-observations/ui/primary-workbench-read-model";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../features/source-observations/ui/primary-workbench-page";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "../../features/source-observations/ui/primary-workbench-route-context";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

type CatalogPrimaryWorkbenchFormIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "clone-provider-profile"
  | "activate-provider-profile"
  | "update-provider-profile-section"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "start-reapply"
  | "start-replay"
>;

type CatalogCommandJobResponse = Readonly<{
  jobId?: unknown;
  status?: unknown;
  progress?: unknown;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const [routeData, profileReviews, controlPlaneOverview] = await Promise.all([
    loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
      api.listSourceObservationIntegrationScopes(query),
    ),
    api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(),
  ]);
  const preliminaryReadModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    controlPlaneOverview,
    canManageCatalog: true,
  });
  const profileAuthoringModel = await selectedProviderProfileAuthoringModel(api, preliminaryReadModel.routeContext);
  const reviewPagination = { limit: 25, offset: 0 };
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
    preliminaryReadModel.routeContext,
    reviewPagination,
  );
  const reviewObservations = reviewQuery
    ? await api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery)
    : null;
  const readModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    profileAuthoringModel,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    canManageCatalog: true,
  });
  await recordCatalogControlPlaneEvents(api, loaderTelemetryEvents(readModel));

  return {
    ...routeData,
    profileReviews,
    profileAuthoringModel,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    readModel,
    requestUrl: request.url,
    commandFeedback: commandFeedbackFromUrl(request.url),
  };
}

async function selectedProviderProfileAuthoringModel(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogProviderProfileAuthoringModel | null> {
  if (!context.providerKey || !context.profileVersion) {
    return null;
  }

  return api.getSourceObservationProviderProfileAuthoringModel<CatalogProviderProfileAuthoringModel>(
    context.providerKey,
    context.profileVersion,
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "") as CatalogPrimaryWorkbenchFormIntent;
  const context = commandContextFromFormData(request.url, formData);
  const selectedObservationIds = observationIdsFromFormData(formData, context.selectedObservationIds);

  try {
    switch (intent) {
      case "start-provider-import": {
        const job = await api.enqueueSourceObservationIntegrationJob<CatalogCommandJobResponse>(
          "import",
          integrationScopeFromContext(context),
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "retry-import-job":
      case "resume-import-job":
      case "cancel-import-job": {
        if (!context.jobId) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, selectedObservationIds },
            intent,
            status: "error",
            result: "job-required",
          });
        }

        const job =
          intent === "retry-import-job"
            ? await api.retrySourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
            : intent === "resume-import-job"
              ? await api.resumeSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
              : await api.cancelSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId);

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: intent === "cancel-import-job" ? "job-cancelled" : "job-queued",
        });
      }
      case "preview-promotion": {
        const preview = await previewPromotionForContext(api, context, selectedObservationIds);

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            promotionPreviewId: promotionPreviewIdFor(preview, context, selectedObservationIds),
          },
          intent,
          status: "success",
          result: "preview-ready",
        });
      }
      case "clone-provider-profile": {
        const sourceProviderKey = stringValue(formData.get("sourceProviderKey")) ?? context.providerKey;
        const sourceProfileVersion = stringValue(formData.get("sourceProfileVersion")) ?? context.profileVersion;
        const targetProfileVersion = stringValue(formData.get("targetProfileVersion"));
        const targetLifecycle = stringValue(formData.get("targetLifecycle")) ?? "draft";
        if (!sourceProviderKey || !sourceProfileVersion || !targetProfileVersion || targetLifecycle !== "draft") {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: "profile-authoring", selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
          });
        }

        const profile = await api.cloneSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
          sourceProviderKey,
          sourceProfileVersion,
          {
            targetProfileVersion,
            lifecycle: "draft",
          },
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            section: "profile-authoring",
            providerKey: profile.providerKey,
            profileVersion: profile.profileVersion,
            selectedObservationIds,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "draft-created",
        });
      }
      case "activate-provider-profile": {
        const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
        const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
        if (!providerKey || !profileVersion) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: "validation-readiness", selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
          });
        }

        const profile = await api.activateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
          providerKey,
          profileVersion,
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            section: "validation-readiness",
            providerKey: profile.providerKey,
            profileVersion: profile.profileVersion,
            selectedObservationIds,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "profile-activated",
        });
      }
      case "update-provider-profile-section": {
        const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
        const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
        const sectionKey = editableProfileSectionKey(stringValue(formData.get("sectionKey")));
        const returnSection =
          sectionKey === "migration-evidence" && context.section === "validation-readiness"
            ? "validation-readiness"
            : "profile-authoring";
        if (!providerKey || !profileVersion || !sectionKey) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: returnSection, selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
            commandSection: sectionKey ?? undefined,
          });
        }

        try {
          const command = await profileSectionCommandFromFormData(api, {
            providerKey,
            profileVersion,
            sectionKey,
            formData,
          });
          const profile = await api.updateSourceObservationProviderProfileSection<CatalogProviderProfileVersionReview>(
            providerKey,
            profileVersion,
            sectionKey,
            command,
          );

          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              section: returnSection,
              providerKey: profile.providerKey,
              profileVersion: profile.profileVersion,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "success",
            result: "section-saved",
            commandSection: sectionKey,
          });
        } catch (error) {
          const result = profileSectionFailureResult(error);

          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: returnSection, providerKey, profileVersion, selectedObservationIds },
            intent,
            status: "error",
            result,
            commandSection: sectionKey,
          });
        }
      }
      case "execute-promotion": {
        if (
          !context.promotionPreviewId ||
          !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))
        ) {
          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "error",
            result: "preview-required",
          });
        }

        const job =
          selectedObservationIds.length > 0
            ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "reject-source-observations": {
        const reason = String(formData.get("reason") ?? "").trim();
        if (!reason) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, selectedObservationIds },
            intent,
            status: "error",
            result: "reason-required",
          });
        }

        const job =
          selectedObservationIds.length > 0
            ? await api.bulkRejectSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
            : await api.bulkRejectSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
                reason,
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "start-reapply": {
        const result =
          selectedObservationIds.length > 0
            ? await api.reapplySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(result.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "defer-source-observations": {
        const reason = String(formData.get("reason") ?? "").trim() || "Deferred from the primary workbench.";
        const job =
          selectedObservationIds.length > 0
            ? await api.deferSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
            : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
                reason,
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds: [],
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "start-replay": {
        const result =
          selectedObservationIds.length > 0
            ? await api.replaySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.replaySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(result.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      default:
        return commandRedirectWithTelemetry(api, {
          context,
          intent,
          status: "error",
          result: "invalid-intent",
        });
    }
  } catch {
    return commandRedirectWithTelemetry(api, {
      context: { ...context, selectedObservationIds },
      intent,
      status: "error",
      result: "command-failed",
    });
  }
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrations.catalog.integrations.catalog.admin") },
];

type CatalogLayoutRouteData = Readonly<{
  actor?: Readonly<{ permissions?: readonly string[] }> | null;
}>;

export default function IntegrationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const catalogLayoutData = useRouteLoaderData("routes/catalog-layout") as CatalogLayoutRouteData | undefined;
  const canManageCatalog = catalogLayoutData?.actor?.permissions?.includes("catalog.manage") ?? true;
  const readModel = useMemo(
    () =>
      canManageCatalog
        ? routeData.readModel
        : buildCatalogPrimaryWorkbenchReadModel({
            requestUrl: routeData.requestUrl,
            scopes: routeData.data,
            profileReviews: routeData.profileReviews,
            profileAuthoringModel: routeData.profileAuthoringModel,
            controlPlaneOverview: routeData.controlPlaneOverview,
            reviewObservations: routeData.reviewObservations,
            reviewPagination: routeData.reviewPagination,
            canManageCatalog,
          }),
    [canManageCatalog, routeData],
  );

  return <CatalogPrimaryWorkbenchPage readModel={readModel} commandFeedback={routeData.commandFeedback} />;
}

function commandContextFromFormData(requestUrl: string, formData: FormData) {
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

function integrationScopeFromContext(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
): SourceObservationIntegrationJobScope {
  const [language, productLineId, seriesId, setId] = context.importScope?.split(":") ?? [];

  return compactScope({
    provider: context.providerKey ?? undefined,
    language: context.sourceObservationFilters.language ?? language,
    seriesId,
    setId: context.sourceObservationFilters.setId ?? setId,
    productLineId,
  });
}

function promotionScopeFromContext(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
): SourceObservationPromotionScope {
  const [language, , , setId] = context.importScope?.split(":") ?? [];

  return compactScope({
    provider: context.providerKey ?? undefined,
    language: context.sourceObservationFilters.language ?? language,
    setId: context.sourceObservationFilters.setId ?? setId,
    status: context.sourceObservationFilters.status ?? "changed",
    search: context.sourceObservationFilters.search,
  });
}

function reapplyScopeFromContext(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
): SourceObservationPromotionScope {
  return {
    ...promotionScopeFromContext(context),
    status: context.sourceObservationFilters.status ?? "promoted",
  };
}

function commandRedirect(input: {
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;
  intent: string;
  status: CatalogPrimaryWorkbenchCommandFeedback["status"];
  result: CatalogPrimaryWorkbenchCommandFeedback["result"];
  commandSection?: string;
}) {
  const redirectSection =
    input.intent === "activate-provider-profile" ||
    (input.intent === "update-provider-profile-section" &&
      input.commandSection === "migration-evidence" &&
      input.context.section === "validation-readiness")
      ? "validation-readiness"
      : input.intent === "clone-provider-profile" || input.intent === "update-provider-profile-section"
        ? "profile-authoring"
        : "import-to-promotion";
  const url = new URL(catalogPrimaryWorkbenchHref(input.context, redirectSection), "https://admin.example");
  url.searchParams.set("commandStatus", input.status);
  url.searchParams.set("commandIntent", input.intent);
  url.searchParams.set("commandResult", input.result);
  if (input.commandSection) {
    url.searchParams.set("commandSection", input.commandSection);
  }

  return redirect(`${url.pathname}${url.search}`);
}

function commandFeedbackFromUrl(url: string | URL): CatalogPrimaryWorkbenchCommandFeedback | null {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const status = parsedUrl.searchParams.get("commandStatus");
  const result = parsedUrl.searchParams.get("commandResult");
  const intent = parsedUrl.searchParams.get("commandIntent") ?? "unknown";

  if ((status !== "success" && status !== "error") || !isCommandFeedbackResult(result)) {
    return null;
  }

  return { status, intent, result };
}

function isCommandFeedbackResult(value: string | null): value is CatalogPrimaryWorkbenchCommandFeedback["result"] {
  return (
    value === "job-queued" ||
    value === "job-cancelled" ||
    value === "preview-ready" ||
    value === "draft-created" ||
    value === "profile-activated" ||
    value === "section-saved" ||
    value === "section-conflict" ||
    value === "section-invalid" ||
    value === "preview-required" ||
    value === "job-required" ||
    value === "reason-required" ||
    value === "unsupported-command" ||
    value === "invalid-intent" ||
    value === "command-failed"
  );
}

function observationIdsFromFormData(formData: FormData, fallback: readonly string[]): readonly string[] {
  const values = String(formData.get("selectedObservationIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? [...new Set(values)] : fallback;
}

function promotionPreviewIdFor(
  preview: SourceObservationPromotionPreview,
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  selectedObservationIds: readonly string[],
): string {
  return [
    "preview",
    promotionPreviewScopeToken(context, selectedObservationIds),
    preview.matched,
    preview.eligible,
  ].join("-");
}

async function confirmsFreshPromotionPreview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  selectedObservationIds: readonly string[],
): Promise<boolean> {
  const preview = await previewPromotionForContext(api, context, selectedObservationIds);
  const expectedPreviewId = promotionPreviewIdFor(preview, context, selectedObservationIds);

  return context.promotionPreviewId === expectedPreviewId;
}

async function previewPromotionForContext(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  selectedObservationIds: readonly string[],
): Promise<SourceObservationPromotionPreview> {
  return selectedObservationIds.length > 0
    ? api.previewBulkPromoteSourceObservationIds<SourceObservationPromotionPreview>([...selectedObservationIds])
    : api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(promotionScopeFromContext(context));
}

async function profileSectionCommandFromFormData(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  input: Readonly<{
    providerKey: string;
    profileVersion: string;
    sectionKey: CatalogProviderProfileEditableSectionKey;
    formData: FormData;
  }>,
): Promise<CatalogProviderProfileSectionUpdateCommand> {
  const profiles = await api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>();
  const profile = profiles.items.find(
    (candidate) => candidate.providerKey === input.providerKey && candidate.profileVersion === input.profileVersion,
  );
  if (!profile) {
    throw new Error("Profile version missing.");
  }

  return profileSectionCommand(profile, input.sectionKey, input.formData);
}

function profileSectionCommand(
  profile: CatalogProviderProfileVersionReview,
  sectionKey: CatalogProviderProfileEditableSectionKey,
  formData: FormData,
): CatalogProviderProfileSectionUpdateCommand {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);

  switch (sectionKey) {
    case "basics":
      return {
        section: "basics",
        displayName: stringValue(formData.get("displayName")) ?? profile.displayName,
        lifecycle: mutableLifecycleValue(formData.get("lifecycle")),
        status: profileStatusValue(formData.get("status")) ?? (profile.status === "active" ? "active" : "planned"),
        capabilities: listValue(formData.get("capabilities"), profile.capabilities),
        supportedScopes: listValue(formData.get("supportedScopes"), profile.supportedScopes),
        languageOptions: listValue(formData.get("languageOptions"), profile.languageOptions),
      };
    case "provider-options": {
      const optionQueries = [...arrayValue(profileRecord?.optionQueries)];
      const index = Math.max(0, Number.parseInt(stringValue(formData.get("optionQueryIndex")) ?? "0", 10) || 0);
      const existing = recordValue(optionQueries[index]) ?? {};
      if (optionQueries.length > 0) {
        optionQueries[index] = {
          ...existing,
          displayName: stringValue(formData.get("optionQueryDisplayName")) ?? stringValue(existing.displayName) ?? "",
          scope: stringValue(formData.get("optionQueryScope")) ?? stringValue(existing.scope) ?? "",
          operation: stringValue(formData.get("optionQueryOperation")) ?? stringValue(existing.operation) ?? "",
        };
      }

      return { section: "provider-options", optionQueries: optionQueries.map(jsonRecord) };
    }
    case "connector": {
      const connector: Record<string, unknown> = {
        ...(recordValue(profileRecord?.connector) ?? {}),
        kind: stringValue(formData.get("connectorKind")) ?? profile.connectorKind,
      };
      const connectorBaseUrl = stringValue(formData.get("connectorBaseUrl"));
      if (connectorBaseUrl) {
        connector.baseUrl = connectorBaseUrl;
      }

      return {
        section: "connector",
        connector: connector as JsonObject,
        mappingConnector: {
          ...(recordValue(contractRecord?.connector) ?? {}),
          kind:
            stringValue(formData.get("connectorKind")) ??
            stringValue(recordValue(contractRecord?.connector)?.kind) ??
            profile.connectorKind,
          transportOwns: listValue(
            formData.get("connectorTransportOwns"),
            stringArrayValue(recordValue(contractRecord?.connector)?.transportOwns),
          ),
          mappingOwns: listValue(
            formData.get("connectorMappingOwns"),
            stringArrayValue(recordValue(contractRecord?.connector)?.mappingOwns),
          ),
        } as JsonObject,
      };
    }
    case "catalog-field-mapping":
      return {
        section: "catalog-field-mapping",
        catalogFieldMapping: {
          ...(recordValue(profileRecord?.catalogFieldMapping) ?? {}),
          blueprintKey:
            stringValue(formData.get("blueprintKey")) ??
            stringValue(recordValue(profileRecord?.catalogFieldMapping)?.blueprintKey) ??
            "",
          categoryKey:
            stringValue(formData.get("categoryKey")) ??
            stringValue(recordValue(profileRecord?.catalogFieldMapping)?.categoryKey) ??
            "",
        } as JsonObject,
      };
    case "source-contract":
      return {
        section: "source-contract",
        sourceContract: {
          owner: stringValue(formData.get("sourceOwner")) ?? profile.sourceContract.owner,
          repository: nullableStringValue(formData.get("sourceRepository"), profile.sourceContract.repository),
          commit: nullableStringValue(formData.get("sourceCommit"), profile.sourceContract.commit),
          documentPath: stringValue(formData.get("sourceDocumentPath")) ?? profile.sourceContract.documentPath,
          fixtureSetVersion: stringValue(formData.get("fixtureSetVersion")) ?? profile.sourceContract.fixtureSetVersion,
        },
      };
    case "fixtures":
      return {
        section: "fixtures",
        fixtures: {
          fixtureRoot: stringValue(formData.get("fixtureRoot")) ?? profile.fixtures.fixtureRoot,
          coveredFlows: listValue(formData.get("coveredFlows"), profile.fixtures.coveredFlows),
          liveProviderCallsAllowed: false,
        },
      };
    case "source-observation": {
      const sourceObservation = recordValue(contractRecord?.sourceObservation);
      return {
        section: "source-observation",
        sourceObservation: sourceObservation
          ? ({
              ...sourceObservation,
              observationId: expressionWithPath(sourceObservation.observationId, formData.get("observationIdPath")),
              externalKey: expressionWithPath(sourceObservation.externalKey, formData.get("externalKeyPath")),
              sourceUrl: expressionWithPath(sourceObservation.sourceUrl, formData.get("sourceUrlPath")),
              sourceUpdatedAt: expressionWithPath(
                sourceObservation.sourceUpdatedAt,
                formData.get("sourceUpdatedAtPath"),
              ),
            } as JsonObject)
          : null,
      };
    }
    case "normalized-observation": {
      const normalizedObservation = recordValue(contractRecord?.normalizedObservation) ?? {};
      return {
        section: "normalized-observation",
        normalizedObservationContract: {
          ...normalizedObservation,
          outputKind:
            stringValue(formData.get("normalizedOutputKind")) ??
            stringValue(normalizedObservation.outputKind) ??
            profile.mappingOutputKind,
          languageCode: expressionWithPath(normalizedObservation.languageCode, formData.get("normalizedLanguagePath")),
        } as JsonObject,
      };
    }
    case "external-references": {
      const contracts = [...arrayValue(contractRecord?.externalReferences)];
      const first = recordValue(contracts[0]) ?? {};
      contracts[0] = {
        ...first,
        providerKey:
          stringValue(formData.get("externalReferenceProviderKey")) ??
          stringValue(first.providerKey) ??
          profile.providerKey,
        target:
          stringValue(formData.get("externalReferenceTarget")) ?? stringValue(first.target) ?? "catalog-item-reference",
        externalKeyPrefix: stringValue(formData.get("externalKeyPrefix")) ?? stringValue(first.externalKeyPrefix) ?? "",
      };

      return {
        section: "external-references",
        externalReferenceExtractionRules: (recordValue(profileRecord?.externalReferenceExtractionRules) ??
          {}) as JsonObject,
        externalReferenceContracts: contracts.map(jsonRecord),
      };
    }
    case "selected-options": {
      const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
      if (!selectedOptionMapping) {
        return { section: "selected-options", selectedOptionMapping: null };
      }
      const dimensions = [...arrayValue(selectedOptionMapping.dimensions)];
      const firstDimension = recordValue(dimensions[0]) ?? {};
      if (dimensions.length > 0) {
        dimensions[0] = {
          ...firstDimension,
          dimensionKey:
            stringValue(formData.get("selectedOptionDimensionKey")) ?? stringValue(firstDimension.dimensionKey) ?? "",
        };
      }

      return {
        section: "selected-options",
        selectedOptionMapping: {
          ...selectedOptionMapping,
          dimensions: dimensions.map(jsonRecord),
        } as JsonObject,
      };
    }
    case "reference-hierarchy": {
      const contracts = [...arrayValue(contractRecord?.referenceHierarchy)];
      const first = recordValue(contracts[0]) ?? {};
      if (contracts.length > 0) {
        contracts[0] = {
          ...first,
          targetTypeKey: stringValue(formData.get("referenceHierarchyType")) ?? stringValue(first.targetTypeKey) ?? "",
          providerAttributeKey:
            stringValue(formData.get("referenceHierarchyProviderAttribute")) ??
            stringValue(first.providerAttributeKey) ??
            "",
        };
      }

      return {
        section: "reference-hierarchy",
        referenceHierarchyMapping: (recordValue(profileRecord?.referenceHierarchyMapping) ?? {}) as JsonObject,
        referenceHierarchyContracts: contracts.map(jsonRecord),
      };
    }
    case "duplicate-prevention": {
      const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention) ?? {};
      return {
        section: "duplicate-prevention",
        duplicatePreventionMapping: (recordValue(profileRecord?.duplicatePreventionMapping) ?? {}) as JsonObject,
        ambiguityRules: (recordValue(profileRecord?.ambiguityRules) ?? {}) as JsonObject,
        duplicatePreventionContract: {
          ...duplicatePrevention,
          exactExternalCatalogItemReferencesFirst:
            formData.get("exactExternalCatalogItemReferencesFirst") === "on" ||
            formData.get("exactExternalCatalogItemReferencesFirst") === "true",
          ambiguousCandidatePolicy:
            stringValue(formData.get("ambiguousCandidatePolicy")) ??
            stringValue(duplicatePrevention.ambiguousCandidatePolicy) ??
            "review-only",
          replayPolicy:
            stringValue(formData.get("replayPolicy")) ??
            stringValue(duplicatePrevention.replayPolicy) ??
            "same-profile-version",
        } as JsonObject,
      };
    }
    case "promotion-plan":
      return {
        section: "promotion-plan",
        promotionCommandPlan: {
          ...(recordValue(contractRecord?.promotionCommandPlan) ?? {}),
          planKind: stringValue(formData.get("promotionPlanKind")) ?? "catalog-item-promotion",
          requiresReview: true,
        } as JsonObject,
      };
    case "retirement-plan": {
      const trackingIssue = numberValue(formData.get("retirementTrackingIssue"));
      const diagnosticText = stringValue(formData.get("retirementReason"));
      if (trackingIssue === null && !diagnosticText) {
        return { section: "retirement-plan", retirementPlan: null };
      }

      return {
        section: "retirement-plan",
        retirementPlan: {
          ...(recordValue(profile.retirementPlan) ?? {}),
          trackingIssue: trackingIssue ?? numberValue(recordValue(profile.retirementPlan)?.trackingIssue) ?? 0,
          removeAfter: "executable-mapping-contract-activated",
          diagnosticText:
            diagnosticText ??
            stringValue(recordValue(profile.retirementPlan)?.diagnosticText) ??
            "Remove retired profile completely before launch.",
        },
      };
    }
    case "migration-evidence":
      return {
        section: "migration-evidence",
        migrationEvidence: {
          ...(profile.migrationEvidence ?? {}),
          evidenceText:
            stringValue(formData.get("migrationEvidenceText")) ??
            profile.migrationEvidence?.evidenceText ??
            "Section update validated through profile authoring.",
          fixtureRunId: nullableStringValue(
            formData.get("migrationFixtureRunId"),
            profile.migrationEvidence?.fixtureRunId ?? null,
          ),
          mappingFingerprintBefore: nullableStringValue(
            formData.get("migrationFingerprintBefore"),
            profile.migrationEvidence?.mappingFingerprintBefore ?? null,
          ),
          mappingFingerprintAfter: nullableStringValue(
            formData.get("migrationFingerprintAfter"),
            profile.migrationEvidence?.mappingFingerprintAfter ?? null,
          ),
          recordedAt:
            stringValue(formData.get("migrationRecordedAt")) ??
            profile.migrationEvidence?.recordedAt ??
            new Date(0).toISOString(),
        },
      };
  }
}

function editableProfileSectionKey(value: string | null): CatalogProviderProfileEditableSectionKey | null {
  switch (value) {
    case "basics":
    case "provider-options":
    case "connector":
    case "catalog-field-mapping":
    case "source-contract":
    case "fixtures":
    case "source-observation":
    case "normalized-observation":
    case "external-references":
    case "selected-options":
    case "reference-hierarchy":
    case "duplicate-prevention":
    case "promotion-plan":
    case "retirement-plan":
    case "migration-evidence":
      return value;
    default:
      return null;
  }
}

function profileSectionFailureResult(
  error: unknown,
): Extract<
  CatalogPrimaryWorkbenchCommandFeedback["result"],
  "section-conflict" | "section-invalid" | "command-failed"
> {
  if (error instanceof CatalogApiError) {
    if (error.status === 409) {
      return "section-conflict";
    }
    if (error.status === 400) {
      return "section-invalid";
    }
  }

  return "command-failed";
}

function promotionPreviewScopeToken(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  selectedObservationIds: readonly string[],
): string {
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonRecord(value: unknown): JsonObject {
  return (recordValue(value) ?? {}) as JsonObject;
}

function listValue(value: FormDataEntryValue | unknown, fallback: readonly string[]): readonly string[] {
  const parsed =
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  return parsed.length > 0 ? parsed : fallback;
}

function stringArrayValue(value: unknown): readonly string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

function nullableStringValue(value: FormDataEntryValue | unknown, fallback: string | null): string | null {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberValue(value: FormDataEntryValue | unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function mutableLifecycleValue(value: FormDataEntryValue | unknown): "draft" | "test" | undefined {
  return value === "draft" || value === "test" ? value : undefined;
}

function profileStatusValue(value: FormDataEntryValue | unknown): "active" | "planned" | undefined {
  return value === "active" || value === "planned" ? value : undefined;
}

function expressionWithPath(value: unknown, pathValue: FormDataEntryValue | unknown): JsonObject {
  const expression = recordValue(value) ?? {
    owner: "catalog-truth",
    uses: ["source-payload"],
    redaction: "none",
  };
  const selector = recordValue(expression.selector) ?? {
    kind: "path",
    required: true,
    nullPolicy: "diagnostic",
  };
  const path = stringValue(pathValue) ?? stringValue(selector.path) ?? "";

  return {
    ...expression,
    selector: {
      ...selector,
      kind: "path",
      path,
    },
  } as JsonObject;
}

function compactScope<T extends Record<string, string | undefined>>(scope: T): T {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => value)) as T;
}

function stringValue(value: FormDataEntryValue | unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function commandRedirectWithTelemetry(
  api: CatalogControlPlaneTelemetryApi,
  input: {
    context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;
    intent: string;
    status: CatalogPrimaryWorkbenchCommandFeedback["status"];
    result: CatalogPrimaryWorkbenchCommandFeedback["result"];
    commandSection?: string;
  },
) {
  await recordCatalogControlPlaneEvents(api, commandTelemetryEvents(input));
  return commandRedirect(input);
}
