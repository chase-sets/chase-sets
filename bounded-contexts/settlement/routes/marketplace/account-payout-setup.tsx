import { t } from "@chase-sets/localization";
import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRevalidator } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { SettlementApiError, createSettlementApiClient, type SettlementPayoutReadinessRow } from "../../client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { PayoutSetupPage, type PayoutSetupMode } from "../../features/payout-readiness/ui/payout-setup-page";

type PayoutSetupActionData = Readonly<{
  error?: string;
}>;

function stripePublishableKey(env: NodeJS.ProcessEnv = process.env) {
  return env.STRIPE_PUBLISHABLE_KEY?.trim() || null;
}

function setupRouteForMode(mode: PayoutSetupMode, setupNotice?: "updated") {
  const url = new URL("http://local/account/payouts/setup");
  if (mode === "management") {
    url.searchParams.set("mode", "manage");
  }
  if (setupNotice) {
    url.searchParams.set("setup", setupNotice);
  }
  return `${url.pathname}${url.search}`;
}

export function resolvePayoutSetupMode(
  requestUrl: URL,
  payoutReadiness: SettlementPayoutReadinessRow,
): PayoutSetupMode {
  if (requestUrl.searchParams.get("mode") === "manage" && payoutReadiness.provider_reference) {
    return "management";
  }

  return "setup";
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.setup",
  });
  const requestUrl = new URL(request.url);
  const settlementApi = createSettlementRequestApiClient(request);
  const payoutReadiness = await settlementApi.getPayoutReadiness();
  const mode = resolvePayoutSetupMode(requestUrl, payoutReadiness as SettlementPayoutReadinessRow);

  return {
    payoutReadiness,
    mode,
    stripePublishableKey: stripePublishableKey(),
    setupNotice:
      requestUrl.searchParams.get("setup") === "updated"
        ? t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.was.refreshed")
        : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.setup",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const mode = formData.get("mode") === "management" ? "management" : "setup";
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    if (intent === "refresh-payout-setup") {
      await settlementApi.refreshPayoutSetup();
      return redirect(setupRouteForMode(mode, "updated"));
    }

    return redirect(setupRouteForMode(mode));
  } catch (error) {
    if (error instanceof SettlementApiError) {
      return { error: error.message };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.marketplace") });

export default function MarketplaceAccountPayoutSetupRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as PayoutSetupActionData | undefined;
  const revalidator = useRevalidator();
  const [providerErrorMessage, setProviderErrorMessage] = useState<string | null>(null);

  const handleProviderExit = useCallback(async () => {
    setProviderErrorMessage(null);
    try {
      await createSettlementApiClient().refreshPayoutSetup();
      revalidator.revalidate();
    } catch (error) {
      setProviderErrorMessage(
        error instanceof Error
          ? error.message
          : t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.could.not"),
      );
    }
  }, [revalidator]);

  return (
    <PayoutSetupPage
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
      mode={data.mode as PayoutSetupMode}
      stripePublishableKey={data.stripePublishableKey}
      setupNotice={data.setupNotice}
      providerErrorMessage={providerErrorMessage ?? actionData?.error ?? null}
      onProviderExit={handleProviderExit}
    />
  );
}
