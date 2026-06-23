import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  appendFreshWriteToken,
  classifyFreshWriteReadError,
  postWriteRecoveryKindForFreshWriteReadError,
  type PostWriteRecoveryKind,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import { IdentityApiError, type Account, type CurrentActorDisplay } from "../../support/request-support/api-client";
import { AccountProfilePage } from "../../features/accounts/ui/account-profile-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

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

function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  return new Request(url, request);
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
    accountRecovery: accountResult.accountRecovery,
    actorDisplay,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.manage",
  });
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  let result: unknown = null;

  if (intent === "update-profile") {
    result = await api.updateAccount(actor.accountId, {
      name: String(formData.get("name") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
    });
  }

  return redirect(appendFreshWriteToken("/account", result));
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.account.account.marketplace") });

export default function MarketplaceAccountRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountProfilePage account={data.account} actorDisplay={data.actorDisplay} />;
}
