import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { loadFreshlyWrittenResource } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { SettlementApiError, type SettlementPayoutRow } from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementPayoutDetailPage } from "../../features/payouts/ui/payout-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    return await loadFreshlyWrittenResource({
      request,
      isNotFound: (error) => error instanceof SettlementApiError && error.status === 404,
      load: async () => ({
        payout: await settlementApi.getPayout(params.payoutId!),
        requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
        showSupportDetails: actor.permissions.includes("payouts.reconcile"),
      }),
    });
  } catch (error) {
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response(t("settlement.routes.marketplace.accountPayout.payout.not.found"), { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountPayout.payout.marketplace") });

export default function MarketplaceAccountPayoutRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementPayoutDetailPage
      backHref="/account/payouts"
      payout={data.payout as SettlementPayoutRow}
      requestSuccess={data.requestSuccess}
      showSupportDetails={data.showSupportDetails}
    />
  );
}
