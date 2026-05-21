import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { identityAdminAuthHostConfig } from "../../support/route-support/host-config";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import type { Session } from "../../features/sessions/ui/contracts";
import { SessionDetailPage } from "../../features/sessions/ui/session-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getSession<Session>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: identityAdminAuthHostConfig.titles.sessionDetail! }];

export default function SessionDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionDetailPage data={data.data} />;
}
