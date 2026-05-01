import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  SettlementApiError,
  type SettlementPayoutRow,
  type SettlementPayoutReadinessRow,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementPayoutListPage } from "../../features/payouts/ui/payout-list-page";

type PayoutActionData = Readonly<{
  error: string;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  if (
    requestUrl.searchParams.get("setup") === "returned" ||
    requestUrl.searchParams.get("setup") === "refresh"
  ) {
    await requireActorFromAuthApi({
      request,
      permission: "payouts.manage",
    });
    await createSettlementRequestApiClient(request).refreshPayoutSetup();
    return redirect("/account/payouts");
  }

  await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const [payouts, payoutReadiness] = await Promise.all([
    settlementApi.listPayouts(),
    settlementApi.getPayoutReadiness(),
  ]);
  return { payouts, payoutReadiness };
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

    if (intent === "start-payout-setup") {
      const result = await settlementApi.createPayoutSetupOnboardingSession({
        returnUrl: new URL("/account/payouts?setup=returned", request.url).toString(),
        refreshUrl: new URL("/account/payouts?setup=refresh", request.url).toString(),
      });

      return redirect(result.url);
    }

    if (intent === "refresh-payout-setup") {
      await settlementApi.refreshPayoutSetup();
      return redirect("/account/payouts");
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
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
      errorMessage={actionData?.error ?? null}
    />
  );
}
