import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { ApiKey, User } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { ApiKeyListPage } from "../../features/api-keys/ui/api-key-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";
import {
  IDENTITY_API_KEY_STATUSES,
  identityListQuery,
  readIdentityListFilters,
} from "../../support/route-support/list-filters";

type ApiKeyActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readIdentityListFilters(request, IDENTITY_API_KEY_STATUSES);
  const [apiKeys, users] = await Promise.all([
    api.listApiKeys<ListResponse<ApiKey>>(identityListQuery(page.query, filters)),
    api.listUsers<ListResponse<User>>("limit=500&offset=0"),
  ]);
  return { apiKeys: { ...apiKeys, limit: page.limit, offset: page.offset }, users: users.items, filters };
}

export const action = defineFormAction({
  intents: {
    create: async ({ request, formData }) => {
      const created = await createIdentityRequestApiClient(request).createApiKey<ApiKeySecretMutationResult>({
        userId: String(formData.get("userId") ?? ""),
        name: String(formData.get("name") ?? ""),
      });
      return Response.json(
        { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies ApiKeyActionData,
        { status: 201 },
      );
    },
  },
  onUnknownIntent: () => {
    throw new Response("Unsupported API key action.", { status: 400 });
  },
});

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.apiKeys.api.keys.identity.admin") }];

export default function ApiKeysRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ApiKeyActionData | undefined;
  return (
    <ApiKeyListPage
      initialData={data.apiKeys}
      users={data.users}
      oneTimeSecret={actionData?.oneTimeSecret}
      filters={data.filters}
    />
  );
}
