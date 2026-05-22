import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { ApiKey } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { ApiKeyListPage } from "../../features/api-keys/ui/api-key-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listApiKeys<ListResponse<ApiKey>>("limit=50&offset=0");
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    await api.createApiKey({
      userId: String(formData.get("userId") ?? ""),
      name: String(formData.get("name") ?? ""),
    });
  }

  return redirect("/identity/api-keys");
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.apiKeys.api.keys.identity.admin") }];

export default function ApiKeysRoute() {
  const data = useLoaderData<typeof loader>();
  return <ApiKeyListPage initialData={data} />;
}
