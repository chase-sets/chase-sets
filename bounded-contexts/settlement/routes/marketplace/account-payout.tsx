import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { loadAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { SettlementApiError, type SettlementPayoutRow } from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import {
  SettlementPayoutDetailPage,
  SettlementPayoutDetailRecoveryPage,
} from "../../features/payouts/ui/payout-detail-page";

const PAYOUT_DETAIL_POST_WRITE_TELEMETRY = {
  boundedContextName: "settlement",
  surface: "account-payout",
  routeId: "account-payout",
  routeTemplate: "/account/payouts/:payoutId",
} as const satisfies PlatformPostWriteTelemetry;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const payoutRead = await loadAfterWrite<SettlementPayoutRow>({
    request,
    isNotFound: (error) => error instanceof SettlementApiError && error.status === 404,
    load: () => settlementApi.getPayout(params.payoutId!),
    telemetry: PAYOUT_DETAIL_POST_WRITE_TELEMETRY,
  });

  if (payoutRead.kind === "pending") {
    return {
      payout: null,
      recovery: "fresh-write-preparing" as const,
      requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
      showSupportDetails: actor.permissions.includes("payouts.reconcile"),
    };
  }

  if (payoutRead.kind === "permanent-failure") {
    const error = "error" in payoutRead ? payoutRead.error : null;
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response(t("settlement.routes.marketplace.accountPayout.payout.not.found"), { status: 404 });
    }

    if (error) {
      throw error;
    }

    throw new Response(t("settlement.routes.marketplace.accountPayout.payout.not.found"), { status: 404 });
  }

  return {
    payout: payoutRead.data,
    requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
    showSupportDetails: actor.permissions.includes("payouts.reconcile"),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountPayout.payout.marketplace") });

export default function MarketplaceAccountPayoutRoute() {
  const data = useLoaderData<typeof loader>();

  if (!data.payout) {
    return <SettlementPayoutDetailRecoveryPage />;
  }

  return (
    <SettlementPayoutDetailPage
      backHref="/account/payouts"
      payout={data.payout as SettlementPayoutRow}
      requestSuccess={data.requestSuccess}
      showSupportDetails={data.showSupportDetails}
    />
  );
}
