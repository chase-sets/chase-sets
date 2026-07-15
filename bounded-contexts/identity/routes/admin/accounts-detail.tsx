import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches } from "react-router";
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
import { IdentityApiError } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";

type AccountHubActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

function identityApiErrorStatus(error: unknown) {
  return error instanceof IdentityApiError ? error.status : null;
}

function identityApiErrorBody(error: unknown) {
  return error instanceof IdentityApiError ? error.body : null;
}

function identityApiErrorCode(error: unknown) {
  const body = identityApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const accountId = params.id!;
  const response = await loadAfterWrite({
    request,
    load: () => api.getAccountAccessHub<AccountAccessHub>(accountId),
    isNotFound: (error) => identityApiErrorStatus(error) === 404,
    getStatus: identityApiErrorStatus,
    getErrorCode: identityApiErrorCode,
    getBody: identityApiErrorBody,
  });

  if (response.kind === "pending") {
    const recoveryApi = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
    return {
      id: accountId,
      data: await recoveryApi.getAccountAccessHub<AccountAccessHub>(accountId),
      initialTab: readTab(request),
    };
  }

  if (response.kind === "permanent-failure") {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Account is unavailable.", { status: 404 });
  }

  return { id: accountId, data: response.data, initialTab: readTab(request) };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
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
    case "create-invitation": {
      tab = "team";
      result = await api.createInvitation({
        invitationId: createId("ivt"),
        accountId,
        email: String(formData.get("email") ?? ""),
        roleKey: String(formData.get("roleKey") ?? "viewer"),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      break;
    }
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

  return redirect(navigateAfterWrite(result, hubHref(accountId, tab)));
}

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
