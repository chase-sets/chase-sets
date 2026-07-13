import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { UnmappedScopeInboxReadModel } from "../../support/request-support/api-client";
import { UnmappedScopeInboxPage } from "../../features/provider-scope-mapping/ui/unmapped-scope-inbox-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const data = await api.getUnmappedScopeInbox<UnmappedScopeInboxReadModel>();
  return { data };
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: t("catalog.routes.admin.scopeCoverage.unmapped.scope.inbox.catalog.admin") },
];

export default function ScopeCoverageRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <UnmappedScopeInboxPage initialData={data} />;
}
