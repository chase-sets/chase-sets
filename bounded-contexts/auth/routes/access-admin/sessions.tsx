import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import type { Session } from "../../features/sessions/ui/contracts";
import { SessionListPage } from "../../features/sessions/ui/session-list-page";
import { readSessionListFilters, sessionListQuery } from "../../features/sessions/ui/list-filters";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readSessionListFilters(request);
  const data = await api.listSessions<ListResponse<Session>>(sessionListQuery(page.query, filters));
  return { ...data, limit: page.limit, offset: page.offset, filters };
}

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.sessions! }];

export default function SessionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionListPage initialData={data} filters={data.filters} />;
}
