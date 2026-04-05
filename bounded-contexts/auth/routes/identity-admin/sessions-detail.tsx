import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { createAuthRequestApiClient } from "../../browser-auth";
import type { Session } from "../../sessions/ui/contracts";
import { SessionDetailPage } from "../../sessions/ui/session-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getSession<Session>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Session Detail | Identity Admin" }];

export default function SessionDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionDetailPage data={data.data} />;
}
