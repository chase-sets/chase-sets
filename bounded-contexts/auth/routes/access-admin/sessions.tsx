import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import type { Session } from "../../features/sessions/ui/contracts";
import { SessionListPage } from "../../features/sessions/ui/session-list-page";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  return api.listSessions<ListResponse<Session>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.sessions! }];

export default function SessionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionListPage initialData={data} />;
}
