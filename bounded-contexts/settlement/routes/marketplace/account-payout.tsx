import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  SettlementApiError,
  type SettlementPayoutRow,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementPayoutDetailPage } from "../../features/payouts/ui/payout-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    const payout = await settlementApi.getPayout(params.payoutId!);
    return {
      payout,
      requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
      showSupportDetails: actor.permissions.includes("payouts.reconcile"),
    };
  } catch (error) {
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response("Payout not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Payout | Marketplace" });

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
