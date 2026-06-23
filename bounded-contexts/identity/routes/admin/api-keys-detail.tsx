import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
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

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const apiKeyId = params.id!;
  let result: unknown = null;

  if (intent === "rotate") {
    result = await api.rotateApiKey(apiKeyId);
  }

  if (intent === "revoke") {
    result = await api.revokeApiKey(apiKeyId);
  }

  return redirect(navigateAfterWrite(result, `/access/api-keys/${apiKeyId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.apiKeysDetail.api.key.detail.identity.admin") },
];

export default function ApiKeyDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <ApiKeyDetailPage data={data.data} />;
}
