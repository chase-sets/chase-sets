import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ApiKey } from "../../support/request-support/api-client";
import { ApiKeyDetailPage } from "../../features/api-keys/ui/api-key-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getApiKey<ApiKey>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "API Key Detail | Identity Admin" }];

export default function ApiKeyDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <ApiKeyDetailPage data={data.data} />;
}

