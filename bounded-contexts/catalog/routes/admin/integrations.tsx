import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useRouteLoaderData } from "react-router";
import { useMemo } from "react";
import type {
  BulkSourceObservationPromotionResult,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
} from "../../client";
import type { CatalogPrimaryWorkbenchActionReadModel } from "../../features/source-observations/api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  SourceObservationIntegrationJobScope,
} from "../../features/source-observations/ui/contracts";
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
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    canManageCatalog: true,
  });

  return {
    ...routeData,
    profileReviews,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    readModel,
    requestUrl: request.url,
    commandFeedback: commandFeedbackFromUrl(request.url),
  };
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

        return commandRedirect({
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
          return commandRedirect({
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

        return commandRedirect({
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
        const preview = await api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(
          promotionScopeFromContext(context),
        );

        return commandRedirect({
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
      case "execute-promotion": {
        if (
          !context.promotionPreviewId ||
          !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))
        ) {
          return commandRedirect({
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

        return commandRedirect({
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
          return commandRedirect({
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

        return commandRedirect({
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
            ? await api.reapplySourceObservations<BulkSourceObservationPromotionResult>([...selectedObservationIds])
            : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(promotionScopeFromContext(context));

        return commandRedirect({
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue((result as CatalogCommandJobResponse).jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "defer-source-observations":
      case "start-replay":
        return commandRedirect({
          context: { ...context, selectedObservationIds },
          intent,
          status: "error",
          result: "unsupported-command",
        });
      default:
        return commandRedirect({
          context,
          intent,
          status: "error",
          result: "invalid-intent",
        });
    }
  } catch {
    return commandRedirect({
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

function commandRedirect(input: {
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;
  intent: string;
  status: CatalogPrimaryWorkbenchCommandFeedback["status"];
  result: CatalogPrimaryWorkbenchCommandFeedback["result"];
}) {
  const url = new URL(catalogPrimaryWorkbenchHref(input.context, "import-to-promotion"), "https://admin.example");
  url.searchParams.set("commandStatus", input.status);
  url.searchParams.set("commandIntent", input.intent);
  url.searchParams.set("commandResult", input.result);

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

  return values.length > 0 ? values : fallback;
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
  const preview = await api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(
    promotionScopeFromContext(context),
  );
  const expectedPreviewId = promotionPreviewIdFor(preview, context, selectedObservationIds);

  return context.promotionPreviewId === expectedPreviewId;
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

function compactScope<T extends Record<string, string | undefined>>(scope: T): T {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => value)) as T;
}

function stringValue(value: FormDataEntryValue | unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
