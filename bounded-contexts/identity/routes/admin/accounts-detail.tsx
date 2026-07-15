import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  defineFormAction,
  defineResourceRoute,
  formActionRedirect,
  type FormActionContext,
} from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useMatches } from "react-router";
import contextManifest from "../../context.json";
import type { AccountAccessHub } from "../../features/access-hub/api/contracts";
import {
  AccountAccessHubPage,
  accountAccessHubTabs,
  type AccountAccessHubTab,
} from "../../features/access-hub/ui/account-access-hub-page";
import { isAccountBadgeKey, type AccountBadgeKey } from "../../features/accounts/ui/account-badges";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";
import { identityApiErrorAdapter } from "../../support/request-support/route-api-error";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";

type AccountHubActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

function readAccountBadgeKey(value: FormDataEntryValue | null): AccountBadgeKey {
  const badgeKey = String(value ?? "");
  if (isAccountBadgeKey(badgeKey)) {
    return badgeKey;
  }
  throw new Response(t("identity.features.accounts.api.route.account.badge.not.supported"), { status: 400 });
}

function readTab(request: Request): AccountAccessHubTab {
  const value = new URL(request.url).searchParams.get("tab") ?? "overview";
  return accountAccessHubTabs.includes(value as AccountAccessHubTab) ? (value as AccountAccessHubTab) : "overview";
}

function hubHref(accountId: string, tab: AccountAccessHubTab) {
  return `/access/accounts/${accountId}?tab=${tab}`;
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "accounts-detail",
  errorAdapter: identityApiErrorAdapter,
  load: ({ request, params }) =>
    createIdentityRequestApiClient(request).getAccountAccessHub<AccountAccessHub>(params.id!),
  map: (data, { request, params }) => ({ id: params.id!, data, initialTab: readTab(request) }),
  onPending: async (_result, { request, params }) => ({
    id: params.id!,
    data: await createIdentityRequestApiClient(requestWithoutFreshWrite(request)).getAccountAccessHub<AccountAccessHub>(
      params.id!,
    ),
    initialTab: readTab(request),
  }),
  onPermanentFailure: (response) => {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Account is unavailable.", { status: 404 });
  },
});

async function handleAccountAction({ request, params, formData, intent }: FormActionContext) {
  const api = createIdentityRequestApiClient(request);
  const accountId = params.id!;
  let result: unknown;
  let tab: AccountAccessHubTab = "overview";

  switch (intent) {
    case "update-profile":
      result = await api.updateAccount(accountId, {
        name: String(formData.get("name") ?? ""),
        displayName: String(formData.get("displayName") ?? ""),
      });
      break;
    case "suspend":
      result = await api.suspendAccount(accountId);
      break;
    case "reactivate":
      result = await api.reactivateAccount(accountId);
      break;
    case "close":
      result = await api.closeAccount(accountId);
      break;
    case "assign-account-badge":
      result = await api.assignAccountBadge(accountId, readAccountBadgeKey(formData.get("badgeKey")));
      break;
    case "remove-account-badge":
      result = await api.removeAccountBadge(accountId, readAccountBadgeKey(formData.get("badgeKey")));
      break;
    case "create-invitation":
      tab = "team";
      result = await api.createInvitation({
        invitationId: createId("ivt"),
        accountId,
        email: String(formData.get("email") ?? ""),
        roleKey: String(formData.get("roleKey") ?? "viewer"),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      break;
    case "change-membership-role":
      tab = "team";
      result = await api.changeMembershipRole(
        String(formData.get("membershipId") ?? ""),
        String(formData.get("roleKey") ?? ""),
      );
      break;
    case "revoke-membership":
      tab = "team";
      result = await api.revokeMembership(String(formData.get("membershipId") ?? ""));
      break;
    case "reinstate-membership":
      tab = "team";
      result = await api.reinstateMembership(String(formData.get("membershipId") ?? ""));
      break;
    case "resend-invitation":
      tab = "team";
      result = await api.resendInvitation(
        String(formData.get("invitationId") ?? ""),
        new Date(String(formData.get("expiresAt") ?? "")).toISOString(),
      );
      break;
    case "cancel-invitation":
      tab = "team";
      result = await api.cancelInvitation(String(formData.get("invitationId") ?? ""));
      break;
    case "decline-invitation":
      tab = "team";
      result = await api.declineInvitation(String(formData.get("invitationId") ?? ""));
      break;
    case "update-user-profile": {
      tab = "team";
      const userId = String(formData.get("userId") ?? "");
      result = await api.updateUser(userId, {
        displayName: String(formData.get("displayName") ?? ""),
        givenName: String(formData.get("givenName") ?? ""),
        familyName: String(formData.get("familyName") ?? ""),
      });
      break;
    }
    case "suspend-user":
      tab = "team";
      result = await api.suspendUser(String(formData.get("userId") ?? ""));
      break;
    case "reactivate-user":
      tab = "team";
      result = await api.reactivateUser(String(formData.get("userId") ?? ""));
      break;
    case "add-user-contact-method": {
      tab = "team";
      const userId = String(formData.get("userId") ?? "");
      result = await api.addUserContactMethod(userId, {
        contactMethodId: createId("ctm"),
        contactMethodType: String(formData.get("contactMethodType") ?? ""),
        value: String(formData.get("contactMethodValue") ?? ""),
      });
      break;
    }
    case "verify-user-contact-method":
      tab = "team";
      result = await api.verifyUserContactMethod(
        String(formData.get("userId") ?? ""),
        String(formData.get("contactMethodId") ?? ""),
      );
      break;
    case "enable-user-auth-method":
      tab = "team";
      result = await api.enableUserAuthMethod(
        String(formData.get("userId") ?? ""),
        String(formData.get("authMethod") ?? ""),
      );
      break;
    case "disable-user-auth-method":
      tab = "team";
      result = await api.disableUserAuthMethod(
        String(formData.get("userId") ?? ""),
        String(formData.get("authMethod") ?? ""),
      );
      break;
    case "create-api-key": {
      const created = await api.createApiKey<ApiKeySecretMutationResult>({
        userId: String(formData.get("userId") ?? ""),
        name: String(formData.get("apiKeyName") ?? ""),
      });
      return Response.json(
        { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies AccountHubActionData,
        { status: 201 },
      );
    }
    case "rotate-api-key": {
      const rotated = await api.rotateApiKey<ApiKeySecretMutationResult>(String(formData.get("apiKeyId") ?? ""));
      return Response.json({
        oneTimeSecret: oneTimeSecretFromMutation(rotated, "rotated"),
      } satisfies AccountHubActionData);
    }
    case "revoke-api-key":
      tab = "api-access";
      result = await api.revokeApiKey(String(formData.get("apiKeyId") ?? ""));
      break;
    default:
      throw new Response("Unsupported account access action.", { status: 400 });
  }

  return formActionRedirect(result, hubHref(accountId, tab));
}

export const action = defineFormAction({
  intents: {
    "update-profile": handleAccountAction,
    suspend: handleAccountAction,
    reactivate: handleAccountAction,
    close: handleAccountAction,
    "assign-account-badge": handleAccountAction,
    "remove-account-badge": handleAccountAction,
    "create-invitation": handleAccountAction,
    "change-membership-role": handleAccountAction,
    "revoke-membership": handleAccountAction,
    "reinstate-membership": handleAccountAction,
    "resend-invitation": handleAccountAction,
    "cancel-invitation": handleAccountAction,
    "decline-invitation": handleAccountAction,
    "update-user-profile": handleAccountAction,
    "suspend-user": handleAccountAction,
    "reactivate-user": handleAccountAction,
    "add-user-contact-method": handleAccountAction,
    "verify-user-contact-method": handleAccountAction,
    "enable-user-auth-method": handleAccountAction,
    "disable-user-auth-method": handleAccountAction,
    "create-api-key": handleAccountAction,
    "rotate-api-key": handleAccountAction,
    "revoke-api-key": handleAccountAction,
  },
});

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.accountsDetail.account.detail.identity.admin") },
];

function useAdminActor(): ResolvedActor {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: ResolvedActor }).actor;
      if (actor) {
        return actor;
      }
    }
  }
  throw new Error("Account access hub requires an admin actor.");
}

export default function AccountDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as AccountHubActionData | undefined;
  return (
    <AccountAccessHubPage
      data={data.data}
      actor={useAdminActor()}
      initialTab={data.initialTab}
      oneTimeSecret={actionData?.oneTimeSecret}
    />
  );
}
