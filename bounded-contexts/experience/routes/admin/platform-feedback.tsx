import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
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
  };
}

export const meta: MetaFunction = () => [
  { title: t("experience.routes.admin.platformFeedback.platform.feedback.experience.admin") },
];

export default function PlatformFeedbackRoute() {
  const data = useLoaderData<typeof loader>();
  return <PlatformFeedbackAdminListPage feedback={data.feedback} metrics={data.metrics} filters={data.filters} />;
}
