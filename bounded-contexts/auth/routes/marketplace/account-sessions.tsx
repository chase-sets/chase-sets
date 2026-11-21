import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import type { Session } from "../../features/sessions/ui/contracts";
import { SessionListPage } from "../../features/sessions/ui/session-list-page";
import { readSessionListFilters, sessionListQuery } from "../../features/sessions/ui/list-filters";

// The Auth API lists only the account holder's own sessions here and ignores a search term, so
// marketplace forwards the status and the page and draws no Search field.
export async function loader({ request }: LoaderFunctionArgs) {
  const api = createAuthRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = { status: readSessionListFilters(request).status, search: "" };
  const data = await api.listSessions<ListResponse<Session>>(sessionListQuery(page.query, filters));
  return { ...data, limit: page.limit, offset: page.offset, filters };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.sessions.ui.sessionListPage.sessions") });

export default function MarketplaceAccountSessionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <SessionListPage hrefBase="/account/sessions" initialData={data} filters={data.filters} searchable={false} />;
}
