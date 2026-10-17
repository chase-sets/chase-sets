import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import {
  classifyFreshWriteReadError,
  postWriteRecoveryKindForFreshWriteReadError,
  type PostWriteRecoveryKind,
} from "@chase-sets/http/responses";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import {
  accountMutationResponse,
  requireInterruptionSafeClient,
} from "../../features/account-management/api/marketplace-action";
import type { MutationResult } from "../../features/account-management/api/runtime";
import { AccountMutationBoundary } from "../../features/account-management/ui/controller";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { requestWithoutFreshWrite, requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import { IdentityApiError, type Account, type CurrentActorDisplay } from "../../support/request-support/api-client";
import { AccountProfilePage } from "../../features/accounts/ui/account-profile-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  createAccountActionErrorHandling,
  type AccountActionFailureResult,
} from "../../support/route-support/account-action-errors";

type AccountLoaderRecovery = Readonly<{
  kind: "temporary-actor-account-fallback";
  recoveryKind: PostWriteRecoveryKind;
}>;

function buildActorAccountFallback(actor: ResolvedActor, actorDisplay: CurrentActorDisplay | null): Account {
  const displayName = actorDisplay?.account.display_name ?? actorDisplay?.account.name ?? actor.accountId;

  return {
    account_id: actor.accountId,
    account_type: "personal",
    badges: actorDisplay?.account.badges ?? [],
    display_name: displayName,
    name: actorDisplay?.account.name ?? displayName,
    status: "active",
    updated_at: "",
  };
}

function identityApiErrorStatus(error: unknown) {
  return error instanceof IdentityApiError ? error.status : null;
}

function identityApiErrorBody(error: unknown) {
  return error instanceof IdentityApiError ? error.body : null;
}

async function getAccountOrActorFallback(
  request: Request,
  api: ReturnType<typeof createIdentityRequestApiClient>,
  actor: ResolvedActor,
  actorDisplay: CurrentActorDisplay | null,
) {
  try {
    return {
      account: await api.getAccount<Account>(actor.accountId),
      accountRecovery: null,
    };
  } catch (error) {
    const classification = classifyFreshWriteReadError({
      request,
      error,
      getStatus: identityApiErrorStatus,
      getBody: identityApiErrorBody,
    });

    if (classification.transient) {
      const recoveryApi = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
      const account = await recoveryApi
        .getAccount<Account>(actor.accountId)
        .catch(() => buildActorAccountFallback(actor, actorDisplay));

      return {
        account,
        accountRecovery: {
          kind: "temporary-actor-account-fallback",
          recoveryKind: postWriteRecoveryKindForFreshWriteReadError(classification),
        },
      };
    }

    throw error;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.view",
  });
  const api = createIdentityRequestApiClient(request);
  const actorDisplay = await api.getCurrentActorDisplay<CurrentActorDisplay>().catch(() => null);
  const accountResult = await getAccountOrActorFallback(request, api, actor, actorDisplay);

  return {
    account: accountResult.account,
    mutationActor: { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
    accountRecovery: accountResult.accountRecovery,
    actorDisplay,
  };
}

export const action = requireInterruptionSafeClient(
  defineFormAction({
    ...createAccountActionErrorHandling().options,
    authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "accounts.manage" }),
    intents: {
      "update-profile": async ({ request, actor, formData }) => {
        const result = await createIdentityRequestApiClient(request).updateAccount<MutationResult>(actor!.accountId, {
          name: String(formData.get("name") ?? ""),
          displayName: String(formData.get("displayName") ?? ""),
        });
        return accountMutationResponse(result, "/account", navigateAfterWrite(result, "/account"));
      },
    },
    onUnknownIntent: () => ({ outcome: "not-recorded", code: "interruption-safe-client-required" }),
  }),
);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.account.account.marketplace") });

export default function MarketplaceAccountRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<AccountActionFailureResult>();
  return (
    <AccountMutationBoundary
      key={`${data.mutationActor.tenantId}:${data.mutationActor.userId}:${data.mutationActor.accountId}`}
      actor={data.mutationActor}
    >
      <AccountProfilePage
        account={data.account}
        actorDisplay={data.actorDisplay}
        errorMessage={actionData?.failure?.message}
      />
    </AccountMutationBoundary>
  );
}
