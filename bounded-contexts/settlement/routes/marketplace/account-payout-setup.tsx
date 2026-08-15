import { t } from "@chase-sets/localization";
import { useCallback, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import {
  defineFormAction,
  formActionRedirect,
  navigateAfterWrite,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { resolveRequiredActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import {
  createSettlementApiClient,
  type SettlementPayoutReadinessRow,
  type SettlementPayoutSetupRefreshResult,
} from "../../client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { settlementApiErrorAdapter } from "../../support/request-support/route-api-error";
import { PayoutSetupPage, type PayoutSetupMode } from "../../features/payout-readiness/ui/payout-setup-page";
import {
  CONNECT_EMBEDDED_COMPONENT_CSP,
  stripeConnectHeaders,
} from "../../features/payout-readiness/ui/stripe-connect-csp";

export { CONNECT_EMBEDDED_COMPONENT_CSP } from "../../features/payout-readiness/ui/stripe-connect-csp";

type PayoutSetupActionData = Readonly<{
  error?: string;
  payoutReadiness?: SettlementPayoutReadinessRow;
  setupNotice?: string;
}>;

type MarketplaceRootData = Readonly<{
  actorDisplay?: {
    user?: {
      primary_email?: string | null;
    } | null;
  } | null;
}>;

const ACCOUNT_PAYOUT_SETUP_POST_WRITE_TELEMETRY = {
  boundedContextName: "settlement",
  surface: "account-desk-settings",
  routeId: "account-desk-settings",
  routeTemplate: "/account/desk/settings",
} as const satisfies PlatformPostWriteTelemetry;

export function headers() {
  return stripeConnectHeaders();
}

function stripePublishableKey(env: NodeJS.ProcessEnv = process.env) {
  return env.STRIPE_PUBLISHABLE_KEY?.trim() || null;
}

function safeAccountReturnTo(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(raw, "http://localhost");
    if (url.origin !== "http://localhost" || !url.pathname.startsWith("/account/")) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function setupRouteForMode(mode: PayoutSetupMode, setupNotice?: "updated", returnTo?: string | null) {
  const url = new URL("http://local/account/desk/settings");
  if (mode === "management") {
    url.searchParams.set("mode", "manage");
  }
  if (setupNotice) {
    url.searchParams.set("setup", setupNotice);
  }
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return `${url.pathname}${url.search}`;
}

function currentAccountPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function accountAccessRequired(returnTo: string) {
  return {
    accountAccessRequired: {
      returnTo,
      title: t("settlement.routes.marketplace.accountPayoutSetup.account.access.required.title"),
      description: t("settlement.routes.marketplace.accountPayoutSetup.account.access.required.description"),
    },
    payoutReadiness: {
      account_id: "",
      status: "not-started" as const,
      missing_requirements: [],
      provider_reference: null,
      onboarding_status: "not-started" as const,
      transfer_capability_status: "inactive" as const,
      payout_capability_status: "inactive" as const,
      payout_destination_status: "missing" as const,
      payout_account_dashboard: "unknown" as const,
      losses_collector: "unknown" as const,
      fees_collector: "unknown" as const,
      requirements_collector: "unknown" as const,
      updated_at: null,
    },
    mode: "setup" as const,
    returnTo: null,
    stripePublishableKey: null,
    setupNotice: null,
  };
}

function returnToWithPayoutFreshness(
  returnTo: string | null,
  refreshResult: SettlementPayoutSetupRefreshResult,
): string | null {
  if (!returnTo || refreshResult.status !== "ready") {
    return null;
  }

  return navigateAfterWrite(refreshResult, returnTo, {
    telemetry: ACCOUNT_PAYOUT_SETUP_POST_WRITE_TELEMETRY,
  });
}

async function returnToWithCompactPayoutFreshness(
  returnTo: string | null,
  refreshResult: SettlementPayoutSetupRefreshResult,
): Promise<string | null> {
  if (!returnTo || refreshResult.status !== "ready") {
    return null;
  }

  return navigateAfterWriteWithPlatformPostWriteToken(refreshResult, returnTo, {
    telemetry: ACCOUNT_PAYOUT_SETUP_POST_WRITE_TELEMETRY,
  });
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
  const requestUrl = new URL(request.url);
  const actorResult = await resolveRequiredActorFromAuthApi({
    request,
    permission: "payouts.setup",
  });
  if (actorResult.kind === "signed-out") {
    throw actorResult.response;
  }
  if (actorResult.kind === "forbidden") {
    return accountAccessRequired(currentAccountPath(request));
  }
  const settlementApi = createSettlementRequestApiClient(request);
  const payoutReadiness = await settlementApi.getPayoutReadiness();
  const mode = resolvePayoutSetupMode(requestUrl, payoutReadiness as SettlementPayoutReadinessRow);
  const returnTo = safeAccountReturnTo(requestUrl.searchParams.get("returnTo"));

  return {
    accountAccessRequired: null,
    payoutReadiness,
    mode,
    returnTo,
    stripePublishableKey: stripePublishableKey(),
    setupNotice:
      requestUrl.searchParams.get("setup") === "updated"
        ? t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.was.refreshed")
        : null,
  };
}

export const action = defineFormAction({
  authorization: { permission: "payouts.setup" },
  errorAdapter: settlementApiErrorAdapter,
  intents: {
    "refresh-payout-setup": async ({ request }) => {
      const returnTo = safeAccountReturnTo(new URL(request.url).searchParams.get("returnTo"));
      const payoutReadiness = await createSettlementRequestApiClient(request).refreshPayoutSetup();
      const returnHref = await returnToWithCompactPayoutFreshness(returnTo, payoutReadiness);
      if (returnHref) {
        return formActionRedirect(null, returnHref);
      }

      return {
        payoutReadiness,
        setupNotice: t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.was.refreshed"),
      };
    },
  },
  onUnknownIntent: ({ request, formData }) =>
    formActionRedirect(
      null,
      setupRouteForMode(
        formData.get("mode") === "management" ? "management" : "setup",
        undefined,
        safeAccountReturnTo(new URL(request.url).searchParams.get("returnTo")),
      ),
    ),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.marketplace") });

export default function MarketplaceAccountPayoutSetupRoute() {
  const data = useLoaderData<typeof loader>();

  if (data.accountAccessRequired) {
    return (
      <AccountAccessRequiredPage
        title={data.accountAccessRequired.title}
        description={data.accountAccessRequired.description}
        returnTo={data.accountAccessRequired.returnTo}
      />
    );
  }

  return <AuthorizedPayoutSetupRoute data={data} />;
}

function AuthorizedPayoutSetupRoute({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const rootData = useRouteLoaderData("root") as MarketplaceRootData | undefined;
  const actionData = useActionData() as PayoutSetupActionData | undefined;
  const revalidator = useRevalidator();
  const [providerErrorMessage, setProviderErrorMessage] = useState<string | null>(null);
  const [providerReadinessSnapshot, setProviderReadinessSnapshot] = useState<SettlementPayoutReadinessRow | null>(null);
  const contactEmail = rootData?.actorDisplay?.user?.primary_email?.trim() || null;

  const handleProviderExit = useCallback(async () => {
    setProviderErrorMessage(null);
    try {
      const refreshedReadiness = await createSettlementApiClient().refreshPayoutSetup();
      const returnHref = returnToWithPayoutFreshness(data.returnTo, refreshedReadiness);
      if (returnHref) {
        window.location.assign(returnHref);
        return;
      }

      setProviderReadinessSnapshot(refreshedReadiness);
      revalidator.revalidate();
    } catch (error) {
      setProviderErrorMessage(
        error instanceof Error
          ? error.message
          : t("settlement.routes.marketplace.accountPayoutSetup.payout.setup.status.could.not"),
      );
    }
  }, [data.returnTo, revalidator]);

  return (
    <PayoutSetupPage
      payoutReadiness={
        providerReadinessSnapshot ??
        actionData?.payoutReadiness ??
        (data.payoutReadiness as SettlementPayoutReadinessRow)
      }
      mode={data.mode as PayoutSetupMode}
      stripePublishableKey={data.stripePublishableKey}
      contactEmail={contactEmail}
      setupNotice={actionData?.setupNotice ?? data.setupNotice}
      providerErrorMessage={providerErrorMessage ?? actionData?.error ?? null}
      onProviderExit={handleProviderExit}
    />
  );
}

function AccountAccessRequiredPage({
  title,
  description,
  returnTo,
}: {
  title: string;
  description: string;
  returnTo: string;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.routes.marketplace.accountPayoutSetup.account.access")}
        title={title}
        description={description}
      />
      <PageSection
        data-testid="account-access-next-step-furniture"
        title={t("settlement.routes.marketplace.accountPayoutSetup.next.step")}
      >
        <Stack gap={3}>
          <Text>{t("settlement.routes.marketplace.accountPayoutSetup.use.an.account.with.payout.setup.access")}</Text>
          <Stack direction="row" gap={2}>
            <LinkButton href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
              {t("settlement.routes.marketplace.accountPayoutSetup.use.a.different.account")}
            </LinkButton>
            <LinkButton href="/account" tone="secondary">
              {t("settlement.routes.marketplace.accountPayoutSetup.view.account")}
            </LinkButton>
          </Stack>
        </Stack>
      </PageSection>
    </Page>
  );
}
