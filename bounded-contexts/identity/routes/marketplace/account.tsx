import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import { IdentityApiError, type Account, type CurrentActorDisplay } from "../../support/request-support/api-client";
import { AccountProfilePage } from "../../features/accounts/ui/account-profile-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

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

async function getAccountOrActorFallback(
  api: ReturnType<typeof createIdentityRequestApiClient>,
  actor: ResolvedActor,
  actorDisplay: CurrentActorDisplay | null,
) {
  try {
    return await api.getAccount<Account>(actor.accountId);
  } catch (error) {
    if (error instanceof IdentityApiError && error.status === 404) {
      return buildActorAccountFallback(actor, actorDisplay);
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

  return {
    account: await getAccountOrActorFallback(api, actor, actorDisplay),
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
