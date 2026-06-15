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
  payoutReadiness?: SettlementPayoutReadinessRow;
  setupNotice?: string;
}>;

export const CONNECT_EMBEDDED_COMPONENT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://connect-js.stripe.com https://js.stripe.com",
  "connect-src 'self'",
  "frame-src https://connect-js.stripe.com https://js.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' data:",
].join("; ");

export function headers() {
  return {
    "Content-Security-Policy": CONNECT_EMBEDDED_COMPONENT_CSP,
    "Cross-Origin-Opener-Policy": "unsafe-none",
  };
}

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
      const payoutReadiness = await settlementApi.refreshPayoutSetup();
      return {
        payoutReadiness,
        setupNotice: t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.was.refreshed"),
      };
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
  const [providerReadinessSnapshot, setProviderReadinessSnapshot] = useState<SettlementPayoutReadinessRow | null>(null);

  const handleProviderExit = useCallback(async () => {
    setProviderErrorMessage(null);
    try {
      setProviderReadinessSnapshot(await createSettlementApiClient().refreshPayoutSetup());
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
      payoutReadiness={
        providerReadinessSnapshot ??
        actionData?.payoutReadiness ??
        (data.payoutReadiness as SettlementPayoutReadinessRow)
      }
      mode={data.mode as PayoutSetupMode}
      stripePublishableKey={data.stripePublishableKey}
      setupNotice={actionData?.setupNotice ?? data.setupNotice}
      providerErrorMessage={providerErrorMessage ?? actionData?.error ?? null}
      onProviderExit={handleProviderExit}
    />
  );
}
