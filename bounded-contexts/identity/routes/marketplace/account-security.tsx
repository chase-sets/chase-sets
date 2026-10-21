import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import {
  accountMutationResponse,
  requireInterruptionSafeClient,
} from "../../features/account-management/api/marketplace-action";
import type { MutationResult } from "../../features/account-management/api/runtime";
import { AccountMutationBoundary } from "../../features/account-management/ui/controller";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ApiKey, User } from "../../support/request-support/api-client";
import { SecurityPage } from "../../features/api-keys/ui/account-security-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import {
  createAccountActionErrorHandling,
  type AccountActionFailureResult,
} from "../../support/route-support/account-action-errors";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "security.manage",
  });
  const api = createIdentityRequestApiClient(request);
  const [user, apiKeys] = await Promise.all([
    api.getUser<User>(actor.userId),
    api.listApiKeys<ListResponse<ApiKey>>(`search=${encodeURIComponent(actor.userId)}`),
  ]);

  return {
    user,
    mutationActor: { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
    apiKeys: apiKeys.items,
  };
}

export const action = requireInterruptionSafeClient(
  defineFormAction({
    ...createAccountActionErrorHandling().options,
    authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "security.manage" }),
    intents: {
      "update-user": async ({ request, actor, formData }) => {
        const result = await createIdentityRequestApiClient(request).updateUser<MutationResult>(actor!.userId, {
          displayName: String(formData.get("displayName") ?? ""),
          givenName: String(formData.get("givenName") ?? ""),
          familyName: String(formData.get("familyName") ?? ""),
        });
        return accountMutationResponse(result, "/account/security", navigateAfterWrite(result, "/account/security"));
      },
      "create-api-key": async ({ request, actor, formData }) => {
        const created = await createIdentityRequestApiClient(request).createApiKey<MutationResult>({
          userId: actor!.userId,
          name: String(formData.get("name") ?? ""),
        });
        return accountMutationResponse(created, "/account/security");
      },
      "rotate-api-key": async ({ request, formData }) => {
        const rotated = await createIdentityRequestApiClient(request).rotateApiKey<MutationResult>(
          String(formData.get("apiKeyId") ?? ""),
        );
        return accountMutationResponse(rotated, "/account/security");
      },
      "revoke-api-key": async ({ request, formData }) => {
        const result = await createIdentityRequestApiClient(request).revokeApiKey<MutationResult>(
          String(formData.get("apiKeyId") ?? ""),
        );
        return accountMutationResponse(result, "/account/security", navigateAfterWrite(result, "/account/security"));
      },
      "unlink-social-login": async ({ request, actor, formData }) => {
        const result = await createIdentityRequestApiClient(request).unlinkSocialLogin<MutationResult>({
          userId: actor!.userId,
          providerName: String(formData.get("providerName") ?? "") as "google" | "facebook",
          linkKey: String(formData.get("linkKey") ?? ""),
        });
        return accountMutationResponse(result, "/account/security", navigateAfterWrite(result, "/account/security"));
      },
    },
    onUnknownIntent: () => ({ outcome: "not-recorded", code: "interruption-safe-client-required" }),
  }),
);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountSecurity.security.marketplace") });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<AccountActionFailureResult>();
  return (
    <AccountMutationBoundary
      key={`${data.mutationActor.tenantId}:${data.mutationActor.userId}:${data.mutationActor.accountId}`}
      actor={data.mutationActor}
    >
      {(secret) => (
        <SecurityPage
          user={data.user}
          apiKeys={data.apiKeys}
          oneTimeSecret={secret}
          errorMessage={actionData && "failure" in actionData ? actionData.failure.message : undefined}
        />
      )}
    </AccountMutationBoundary>
  );
}
