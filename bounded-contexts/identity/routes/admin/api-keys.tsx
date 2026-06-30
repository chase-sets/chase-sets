import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { navigateAfterWrite, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { ApiKey } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { ApiKeyListPage } from "../../features/api-keys/ui/api-key-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

type ApiKeyMutationResult = Readonly<{ id?: unknown }>;

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const data = await api.listApiKeys<ListResponse<ApiKey>>(page.query);
  return { ...data, limit: page.limit, offset: page.offset };
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent !== "create") {
    throw new Response("Unsupported API key action.", { status: 400 });
  }

  const created = await api.createApiKey<ApiKeyMutationResult>({
    userId: String(formData.get("userId") ?? ""),
    name: String(formData.get("name") ?? ""),
  });
  if (typeof created.id !== "string" || !created.id.trim()) {
    throw new Response("API key create did not return an id.", { status: 502 });
  }

  return redirect(navigateAfterWrite(created, `/access/api-keys/${created.id}`));
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.apiKeys.api.keys.identity.admin") }];

export default function ApiKeysRoute() {
  const data = useLoaderData<typeof loader>();
  return <ApiKeyListPage initialData={data} />;
}
