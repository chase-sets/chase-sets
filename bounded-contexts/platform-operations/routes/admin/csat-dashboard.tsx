import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CsatAdminPage, type RefusedCsatDashboard } from "../../features/csat-dashboard/ui/admin-page";
import { createExperienceRequestApiClient } from "../../support/request-support/api-client";
import {
  csatQueryRefusalReasons,
  transactionalCsatV1,
  type CsatAdminQueueFilters,
  type CsatQueryRefusalReason,
} from "../../support/request-support/customer-feedback-csat";
import { ExperienceApiError } from "../../support/request-support/platform-feedback-client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const url = new URL(request.url);
  try {
    return await api.getCsatDashboard(url.searchParams.toString());
  } catch (error) {
    const refusal = refusalReason(error);
    if (!refusal) throw error;
    return { refusal, filters: filtersFrom(url.searchParams) } satisfies RefusedCsatDashboard;
  }
}

/** The reason Customer Feedback gave for refusing the filters, when it refused them. */
function refusalReason(error: unknown): CsatQueryRefusalReason | null {
  if (!(error instanceof ExperienceApiError) || error.status !== 400) return null;
  const body = error.body;
  const detail = body && typeof body === "object" && "error" in body ? body.error : null;
  if (!detail || typeof detail !== "object" || !("code" in detail) || detail.code !== "validation_failed") return null;
  const reason = "reason" in detail ? detail.reason : null;
  return csatQueryRefusalReasons.find((known) => known === reason) ?? null;
}

/** The filters as the address names them, so the refused form shows what was chosen. */
function filtersFrom(query: URLSearchParams): CsatAdminQueueFilters {
  const first = (name: string) => query.get(name)?.split(",")[0]?.trim() || undefined;
  const list = (name: string) => {
    const value = first(name);
    return value ? [value] : undefined;
  };
  const surveyVersion = first("surveyVersion");
  const rating = Number(first("ratings"));
  const consent = first("followUpConsent");
  return {
    from: first("from"),
    to: first("to"),
    ...(surveyVersion ? { surveyVersion: { ...transactionalCsatV1.id, surveyVersion } } : {}),
    outcomeCodes: list("outcomeCodes") as CsatAdminQueueFilters["outcomeCodes"],
    customerRoles: list("customerRoles") as CsatAdminQueueFilters["customerRoles"],
    states: list("states"),
    ratings: rating >= 1 && rating <= 5 ? [rating as 1 | 2 | 3 | 4 | 5] : undefined,
    followUpConsent: consent === "granted" || consent === "not-granted" ? consent : undefined,
  };
}

export const meta: MetaFunction = () => [{ title: t("experience.csatAdmin.title") }];

export default function CsatDashboardRoute() {
  return <CsatAdminPage data={useLoaderData<typeof loader>()} />;
}
