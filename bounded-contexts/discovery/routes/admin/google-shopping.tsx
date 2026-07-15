import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches, useRevalidator, useSearchParams } from "react-router";
import {
  createGoogleShoppingOperationsRequestApiClient,
  googleShoppingOperationsListQuery,
  readGoogleShoppingOperationsFilters,
} from "../../features/google-shopping-operations/api/request-client";
import { GoogleShoppingOperationsPage } from "../../features/google-shopping-operations/ui/google-shopping-operations-page";
import type { GoogleShoppingOperationsNotice } from "../../features/google-shopping-operations/ui/contracts";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";

const routeKey = "discovery.googleShoppingOperations";
const routePath = "/growth/google-shopping";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t(`${routeKey}.requestFailed`);
}

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export async function loader({ request }: LoaderFunctionArgs) {
  const filters = readGoogleShoppingOperationsFilters(request);
  const api = createGoogleShoppingOperationsRequestApiClient(request);

  try {
    return {
      data: await api.listFeedRows(googleShoppingOperationsListQuery(filters)),
      filters,
      unavailableMessage: null,
    };
  } catch (error) {
    return {
      data: {
        generatedAt: new Date().toISOString(),
        filter: filters.filter,
        search: filters.search,
        limit: filters.limit,
        refreshWindowDays: filters.refreshWindowDays,
        refreshCutoff: new Date().toISOString(),
        summary: {
          totalRows: 0,
          eligibleRows: 0,
          excludedRows: 0,
          failedRows: 0,
          disapprovedRows: 0,
          pendingDeleteRows: 0,
          staleRows: 0,
          nearingRefreshRows: 0,
          pendingDiagnosticsRows: 0,
        },
        rows: [],
      },
      filters,
      unavailableMessage: errorMessage(error),
    };
  }
}

async function handleAction(intent: string, { request, formData }: FormActionContext) {
  const api = createGoogleShoppingOperationsRequestApiClient(request);
  const currentUrl = new URL(request.url);

  try {
    if (intent === "live-full-sync" || intent === "live-maintenance-sync" || intent === "targeted-retry") {
      return { error: t(`${routeKey}.liveGateError`) };
    }

    if (intent === "dry-run-full-sync") {
      const job = await api.enqueueFullSyncJob({
        mode: "dry-run",
        batchSize: readPositiveInteger(formData, "batchSize"),
      });
      return redirect(withNotice(currentUrl, { fullSyncJobId: job.jobId }));
    }

    if (intent === "dry-run-maintenance-sync") {
      const result = await api.enqueueMaintenanceSyncJob({
        mode: "dry-run",
        limit: readPositiveInteger(formData, "limit"),
        refreshWindowDays: readPositiveInteger(formData, "refreshWindowDays"),
      });
      return redirect(
        withNotice(currentUrl, {
          maintenanceJobId: result.job?.jobId ?? "",
          maintenanceTotal: String(result.summary.total),
        }),
      );
    }

    if (intent === "dry-run-diagnostics-refresh") {
      const job = await api.enqueueDiagnosticsRefreshJob({
        mode: "dry-run",
        batchSize: readPositiveInteger(formData, "batchSize"),
      });
      return redirect(withNotice(currentUrl, { diagnosticsJobId: job.jobId }));
    }
  } catch (error) {
    return { error: errorMessage(error) };
  }

  return null;
}

export const action = defineFormAction({
  intents: {
    "dry-run-diagnostics-refresh": (context) => handleAction("dry-run-diagnostics-refresh", context),
    "dry-run-full-sync": (context) => handleAction("dry-run-full-sync", context),
    "dry-run-maintenance-sync": (context) => handleAction("dry-run-maintenance-sync", context),
    "live-full-sync": (context) => handleAction("live-full-sync", context),
    "live-maintenance-sync": (context) => handleAction("live-maintenance-sync", context),
    "targeted-retry": (context) => handleAction("targeted-retry", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export default function GoogleShoppingOperationsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const revalidator = useRevalidator();

  return (
    <GoogleShoppingOperationsPage
      data={data.data}
      filters={data.filters}
      unavailableMessage={data.unavailableMessage}
      notice={noticeFromSearchParams(searchParams)}
      actionError={actionData?.error ?? null}
      actorPermissions={useAdminActorPermissions()}
      latestJobIds={jobIdsFromSearchParams(searchParams)}
      onJobTerminal={revalidator.revalidate}
    />
  );
}

function useAdminActorPermissions() {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }

  return [];
}

function readPositiveInteger(formData: FormData, key: string) {
  const parsed = Number(formData.get(key));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function withNotice(currentUrl: URL, values: Record<string, string>) {
  const next = new URL(routePath, currentUrl);
  for (const [key, value] of currentUrl.searchParams.entries()) {
    if (!key.endsWith("JobId") && key !== "maintenanceTotal") {
      next.searchParams.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      next.searchParams.set(key, value);
    }
  }
  return `${next.pathname}${next.search}`;
}

function noticeFromSearchParams(searchParams: URLSearchParams): GoogleShoppingOperationsNotice | null {
  const fullSyncJobId = searchParams.get("fullSyncJobId");
  if (fullSyncJobId) {
    return { tone: "success", message: t(`${routeKey}.fullSyncQueued`, { jobId: fullSyncJobId }) };
  }

  const diagnosticsJobId = searchParams.get("diagnosticsJobId");
  if (diagnosticsJobId) {
    return { tone: "success", message: t(`${routeKey}.diagnosticsQueued`, { jobId: diagnosticsJobId }) };
  }

  const maintenanceTotal = searchParams.get("maintenanceTotal");
  const maintenanceJobId = searchParams.get("maintenanceJobId");
  if (maintenanceTotal) {
    return {
      tone: "success",
      message: maintenanceJobId
        ? t(`${routeKey}.maintenanceQueued`, { jobId: maintenanceJobId, total: maintenanceTotal })
        : t(`${routeKey}.maintenancePreviewed`, { total: maintenanceTotal }),
    };
  }

  return null;
}

function jobIdsFromSearchParams(searchParams: URLSearchParams): readonly string[] {
  return ["fullSyncJobId", "maintenanceJobId", "diagnosticsJobId"].flatMap((key) => {
    const value = searchParams.get(key);
    return value ? [value] : [];
  });
}
