import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ScheduleDetailPage } from "../../features/schedules/ui/schedule-detail-page";
import { createCommercialTermsRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCommercialTermsRequestApiClient(request);
  return {
    schedule: await api.getSchedule(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Fee Schedule Detail | Commercial Terms" }];

export default function CommercialTermsScheduleDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <ScheduleDetailPage schedule={data.schedule} />;
}
