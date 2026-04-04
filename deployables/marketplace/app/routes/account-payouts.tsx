import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  SettlementApiError,
  SettlementPayoutListPage,
  type SettlementPayoutRow,
} from "@chase-sets/settlement/web";
import { createMarketplaceSettlementApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

type PayoutActionData = Readonly<{
  error: string;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "payouts.view");
  const settlementApi = createMarketplaceSettlementApiClient(request);

  const payouts = await settlementApi.listPayouts();
  return { payouts };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "payouts.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const settlementApi = createMarketplaceSettlementApiClient(request);

  try {
    if (intent === "schedule-payout") {
      const result = (await settlementApi.createPayout({
        amount: formData.get("amount"),
        destinationReference: formData.get("destinationReference") || null,
        note: formData.get("note") || null,
      })) as Readonly<{ id: string }>;

      return redirect(`/account/payouts/${result.id}`);
    }

    return redirect("/account/payouts");
  } catch (error) {
    if (error instanceof SettlementApiError) {
      return { error: error.message };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Payouts | Marketplace" });

export default function MarketplaceAccountPayoutsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as PayoutActionData | undefined;

  return (
    <SettlementPayoutListPage
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      errorMessage={actionData?.error ?? null}
    />
  );
}
