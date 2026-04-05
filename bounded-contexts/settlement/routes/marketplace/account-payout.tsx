import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  SettlementApiError,
  type SettlementPayoutRow,
} from "../../request-support/api-client";
import { createSettlementRequestApiClient } from "../../request-support/api-client";
import { SettlementPayoutDetailPage } from "../../payouts/ui/payout-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    const payout = await settlementApi.getPayout(params.payoutId!);
    return { payout };
  } catch (error) {
    if (error instanceof SettlementApiError && error.status === 404) {
      throw new Response("Payout not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const settlementApi = createSettlementRequestApiClient(request);
  const payoutId = params.payoutId!;

  try {
    if (intent === "send-payout") {
      await settlementApi.sendPayout(payoutId);
      return redirect(`/account/payouts/${payoutId}`);
    }

    if (intent === "complete-payout") {
      await settlementApi.completePayout(payoutId);
      return redirect(`/account/payouts/${payoutId}`);
    }

    if (intent === "fail-payout") {
      await settlementApi.failPayout(payoutId, {
        failureReason: formData.get("failureReason") || null,
      });
      return redirect(`/account/payouts/${payoutId}`);
    }

    return null;
  } catch (error) {
    if (error instanceof SettlementApiError) {
      return { error: error.message };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Payout | Marketplace" });

export default function MarketplaceAccountPayoutRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <SettlementPayoutDetailPage
      backHref="/account/payouts"
      payout={data.payout as SettlementPayoutRow}
      errorMessage={actionData?.error ?? null}
    />
  );
}
