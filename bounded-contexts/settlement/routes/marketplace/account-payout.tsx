import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { defineResourceRoute, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { createSettlementRequestApiClient, type SettlementPayoutRow } from "../../support/request-support/api-client";
import { settlementApiErrorAdapter } from "../../support/request-support/route-api-error";
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

type PayoutLoaderData = Readonly<{
  payout: SettlementPayoutRow | null;
  recovery?: "fresh-write-preparing";
  requestSuccess: boolean;
  showSupportDetails: boolean;
}>;

export const loader = defineResourceRoute<SettlementPayoutRow, PayoutLoaderData>({
  manifest: contextManifest,
  routeId: "account-payout",
  authorization: { permission: "payouts.view" },
  errorAdapter: settlementApiErrorAdapter,
  load: ({ request, params }) => createSettlementRequestApiClient(request).getPayout(params.payoutId!),
  map: (payout, { request, actor }) => ({
    payout,
    requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
    showSupportDetails: actor!.permissions.includes("payouts.reconcile"),
  }),
  telemetry: PAYOUT_DETAIL_POST_WRITE_TELEMETRY,
  onPending: (_result, { request, actor }) => ({
    payout: null,
    recovery: "fresh-write-preparing" as const,
    requestSuccess: new URL(request.url).searchParams.get("requested") === "1",
    showSupportDetails: actor!.permissions.includes("payouts.reconcile"),
  }),
  messages: { notFound: t("settlement.routes.marketplace.accountPayout.payout.not.found") },
});

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
