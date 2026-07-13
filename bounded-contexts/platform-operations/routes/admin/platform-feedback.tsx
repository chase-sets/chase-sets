import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useMatches } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { PlatformFeedbackAdminListPage } from "../../features/platform-feedback/ui/admin-pages";
import { createExperienceRequestApiClient } from "../../support/request-support/api-client";

function filterValue(search: URLSearchParams, key: string) {
  return search.get(key) ?? "all";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const url = new URL(request.url);
  const filters = {
    status: filterValue(url.searchParams, "status"),
    topic: filterValue(url.searchParams, "topic"),
    workflow: filterValue(url.searchParams, "workflow"),
  };
  const query = new URLSearchParams({
    limit: "100",
    offset: "0",
  });

  for (const [key, value] of Object.entries(filters)) {
    if (value !== "all") {
      query.set(key, value);
    }
  }

  const [feedback, metrics] = await Promise.all([
    api.listPlatformFeedback(query.toString()),
    api.getPlatformFeedbackMetrics(),
  ]);

  return {
    feedback,
    metrics,
    filters,
    exportHref: `/api/experience/platform-feedback/export?${query.toString()}`,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const feedbackIds = formData.getAll("feedbackIds").map(String).filter(Boolean);
  let result: unknown = null;

  if (intent === "bulk-review") {
    result = await api.bulkMarkReviewed({ feedbackIds });
  }

  if (intent === "bulk-archive") {
    result = await api.bulkArchive({ feedbackIds });
  }

  throw redirect(navigateAfterWrite(result, `/support/platform-feedback${url.search}`));
}

export const meta: MetaFunction = () => [
  { title: t("experience.routes.admin.platformFeedback.platform.feedback.experience.admin") },
];

export default function PlatformFeedbackRoute() {
  const data = useLoaderData<typeof loader>();
  const permissions = useAdminActorPermissions();
  return (
    <PlatformFeedbackAdminListPage
      feedback={data.feedback}
      metrics={data.metrics}
      filters={data.filters}
      exportHref={data.exportHref}
      canExport={permissions.includes("platform-feedback.export")}
      canManage={permissions.includes("platform-feedback.manage")}
    />
  );
}

function useAdminActorPermissions(): readonly string[] {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }

  return [];
}
