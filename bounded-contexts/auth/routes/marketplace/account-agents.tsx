import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";
import { createUcpOAuthRequestApiClient } from "../../support/request-support/api-client";
import type { AgentGrant } from "../../features/agent-grants/ui/contracts";
import { AgentGrantListPage } from "../../features/agent-grants/ui/agent-grant-list-page";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createUcpOAuthRequestApiClient(request);
  const data = await api.listAgentGrants<{ authorizations: AgentGrant[] }>();
  return {
    items: data.authorizations,
    total: data.authorizations.length,
    count: data.authorizations.length,
    mcpUrl: `${new URL(request.url).origin}/mcp`,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents") });

export default function MarketplaceAccountAgentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <AgentGrantListPage hrefBase="/account/agents" initialData={data} mcpUrl={data.mcpUrl} />;
}
