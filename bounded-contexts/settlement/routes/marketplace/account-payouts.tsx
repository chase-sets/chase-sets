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
import { SettlementPayoutListPage } from "../../payouts/ui/payout-list-page";

type PayoutActionData = Readonly<{
  error: string;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const payouts = await settlementApi.listPayouts();
  return { payouts };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const settlementApi = createSettlementRequestApiClient(request);

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
  buildOpenGraphMeta({ title: "Payouts | Marketplace" });

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
