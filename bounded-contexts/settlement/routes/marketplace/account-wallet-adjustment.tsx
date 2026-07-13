import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  SettlementApiError,
  type SettlementWalletAdjustmentAccountDetail,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementWalletAdjustmentAccountDetailPage } from "../../features/wallets/ui/wallet-adjustment-account-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    const adjustment = await settlementApi.getAccountWalletAdjustment(params.reference!);
    return { adjustment };
  } catch (error) {
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response(t("settlement.routes.marketplace.accountWalletAdjustment.adjustment.not.found"), {
        status: 404,
      });
    }
    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountWalletAdjustment.wallet.adjustment") });

export default function MarketplaceAccountWalletAdjustmentRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SettlementWalletAdjustmentAccountDetailPage
      adjustment={data.adjustment as SettlementWalletAdjustmentAccountDetail}
    />
  );
}
