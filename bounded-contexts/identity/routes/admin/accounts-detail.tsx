import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useMatches } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { IdentityApiError, type Account } from "../../support/request-support/api-client";
import { isAccountBadgeKey, type AccountBadgeKey } from "../../features/accounts/ui/account-badges";
import { AccountDetailPage } from "../../features/accounts/ui/account-detail-page";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const accountId = params.id!;
  const response = await loadAfterWrite({
    request,
    load: () => api.getAccount<Account>(accountId),
    isNotFound: (error) => identityApiErrorStatus(error) === 404,
    getStatus: identityApiErrorStatus,
    getErrorCode: identityApiErrorCode,
    getBody: identityApiErrorBody,
  });

  if (response.kind === "pending") {
    const recoveryApi = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
    return {
      id: accountId,
      data: await recoveryApi.getAccount<Account>(accountId),
    };
  }

  if (response.kind === "permanent-failure") {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Account is unavailable.", { status: 404 });
  }

  return {
    id: accountId,
    data: response.data,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const accountId = params.id!;
  let result: unknown = null;

  if (intent === "update-profile") {
    result = await api.updateAccount(accountId, {
      name: String(formData.get("name") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
    });
  }

  if (intent === "create-invitation") {
    const invitationId = createId("ivt");
    result = await api.createInvitation({
      invitationId,
      accountId,
      email: String(formData.get("email") ?? ""),
      roleKey: String(formData.get("roleKey") ?? "viewer"),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    return redirect(navigateAfterWrite(result, `/access/invitations/${invitationId}`));
  }

  if (intent === "suspend") {
    result = await api.suspendAccount(accountId);
  }

  if (intent === "reactivate") {
    result = await api.reactivateAccount(accountId);
  }

  if (intent === "close") {
    result = await api.closeAccount(accountId);
  }

  if (intent === "assign-account-badge") {
    result = await api.assignAccountBadge(accountId, readAccountBadgeKey(formData.get("badgeKey")));
  }

  if (intent === "remove-account-badge") {
    result = await api.removeAccountBadge(accountId, readAccountBadgeKey(formData.get("badgeKey")));
  }

  return redirect(navigateAfterWrite(result, `/access/accounts/${accountId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.accountsDetail.account.detail.identity.admin") },
];

function useAdminActorPermissions(): readonly string[] {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }
  return [];
}

export default function AccountDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountDetailPage data={data.data} actorPermissions={useAdminActorPermissions()} />;
}
