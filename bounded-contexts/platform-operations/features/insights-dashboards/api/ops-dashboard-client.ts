import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  OpsGmvSeriesPoint,
  OpsGranularity,
  OpsKpiSummary,
  OpsLiquiditySummary,
  OpsTopCatalogItem,
} from "./ops-contracts";
import type { GmvReconciliationRun } from "../read-model/ops-queries";

export type {
  GmvReconciliationRun,
  OpsGmvSeriesPoint,
  OpsGranularity,
  OpsKpiSummary,
  OpsLiquiditySummary,
  OpsTopCatalogItem,
};

export type OpsDashboardSummaryResponse = Readonly<{
  from: string;
  to: string;
  summary: OpsKpiSummary;
  liquidity: OpsLiquiditySummary;
  topCatalogItems: readonly OpsTopCatalogItem[];
}>;

export type OpsDashboardSeriesResponse = Readonly<{
  from: string;
  to: string;
  granularity: OpsGranularity;
  series: readonly OpsGmvSeriesPoint[];
}>;

function resolveOpsDashboardApiUrl(
  request: Request,
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
) {
  const url = new URL(resolveRequestApiBaseUrl(request, `/api/platform/insights/ops${path}`));
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }
  return (await response.json()) as T;
}

export async function loadOpsDashboardSummary(
  request: Request,
  params: Readonly<{ from?: string; to?: string; limit?: string }> = {},
): Promise<OpsDashboardSummaryResponse> {
  const response = await fetch(resolveOpsDashboardApiUrl(request, "/summary", params), {
    headers: createForwardedAuthHeaders(request),
  });
  return parseJsonOrThrow(response);
}

export async function loadOpsDashboardSeries(
  request: Request,
  params: Readonly<{ from?: string; to?: string; granularity?: OpsGranularity }> = {},
): Promise<OpsDashboardSeriesResponse> {
  const response = await fetch(resolveOpsDashboardApiUrl(request, "/series", params), {
    headers: createForwardedAuthHeaders(request),
  });
  return parseJsonOrThrow(response);
}

export async function loadOpsDashboardReconciliationRuns(
  request: Request,
  params: Readonly<{ limit?: string }> = {},
): Promise<Readonly<{ items: readonly GmvReconciliationRun[]; count: number }>> {
  const response = await fetch(resolveOpsDashboardApiUrl(request, "/reconciliation-runs", params), {
    headers: createForwardedAuthHeaders(request),
  });
  return parseJsonOrThrow(response);
}
