import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ApiKeyListPage, type ApiKey } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createIdentityRequestApiClient } from "../../client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listApiKeys<ListResponse<ApiKey>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "API Keys | Identity Admin" }];

export default function ApiKeysRoute() {
  const data = useLoaderData<typeof loader>();
  return <ApiKeyListPage initialData={data} />;
}

