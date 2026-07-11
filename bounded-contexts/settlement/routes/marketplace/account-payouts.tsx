import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi, resolveRequiredActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { Card, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import {
  SettlementApiError,
  type SettlementPayoutPreview,
  type SettlementPayoutRow,
  type SettlementPayoutReadinessRow,
  type SettlementWalletRow,
} from "../../support/request-support/api-client";
import { createSettlementRequestApiClient } from "../../support/request-support/api-client";
import { SettlementPayoutListPage } from "../../features/payouts/ui/payout-list-page";
import { resolvePayoutAmountSelection } from "../../features/payouts/api/payout-form";

type PayoutActionData = Readonly<{
  error?: string;
  draft?: Readonly<{
    amount: string;
    note: string | null;
  }>;
  confirmation?: Readonly<{
    amount: string;
    note: string | null;
    preview: SettlementPayoutPreview;
  }>;
  refreshedPayoutReadiness?: SettlementPayoutReadinessRow;
  setupNotice?: string;
}>;

const ACCOUNT_PAYOUTS_POST_WRITE_TELEMETRY = {
  boundedContextName: "settlement",
  surface: "account-payouts",
  routeId: "account-payouts",
  routeTemplate: "/account/payouts",
} as const satisfies PlatformPostWriteTelemetry;

function currentAccountPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function accountAccessRequired(returnTo: string) {
  return {
    accountAccessRequired: {
      returnTo,
      title: t("settlement.routes.marketplace.accountPayouts.account.access.required.title"),
      description: t("settlement.routes.marketplace.accountPayouts.account.access.required.description"),
    },
    wallet: {
      account_id: "",
      pending_balance_amount: "0.00",
      available_balance_amount: "0.00",
      total_credited_amount: "0.00",
      total_debited_amount: "0.00",
      currency_code: "usd",
      opened_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    payouts: { items: [], total: 0, count: 0 },
    payoutReadiness: null,
    canRequestPayouts: false,
    canSetupPayouts: false,
    setupNotice: null,
  };
}

function normalizeQuickAmount(formData: FormData) {
  return resolvePayoutAmountSelection({
    amount: String(formData.get("amount") ?? ""),
    shortcut: String(formData.get("quickAmount") ?? ""),
    availableAmount: String(formData.get("availableAmount") ?? "0"),
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("setup") === "returned" || requestUrl.searchParams.get("setup") === "refresh") {
    const setupActorResult = await resolveRequiredActorFromAuthApi({
      request,
      permission: "payouts.setup",
    });
    if (setupActorResult.kind === "signed-out") {
      throw setupActorResult.response;
    }
    if (setupActorResult.kind === "forbidden") {
      return accountAccessRequired(currentAccountPath(request));
    }
    await createSettlementRequestApiClient(request).refreshPayoutSetup();
    return redirect("/account/payouts?setup=updated");
  }

  const actorResult = await resolveRequiredActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  if (actorResult.kind === "signed-out") {
    throw actorResult.response;
  }
  if (actorResult.kind === "forbidden") {
    return accountAccessRequired(currentAccountPath(request));
  }
  const actor = actorResult.actor;
  const settlementApi = createSettlementRequestApiClient(request);

  const [wallet, payouts, payoutReadiness] = await Promise.all([
    settlementApi.getWallet(),
    settlementApi.listPayouts(),
    settlementApi.getPayoutReadiness(),
  ]);
  return {
    accountAccessRequired: null,
    wallet,
    payouts,
    payoutReadiness,
    canRequestPayouts: actor.permissions.includes("payouts.request"),
    canSetupPayouts: actor.permissions.includes("payouts.setup"),
    setupNotice:
      requestUrl.searchParams.get("setup") === "updated"
        ? t("settlement.routes.marketplace.accountPayouts.payout.setup.status.was.refreshed")
        : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const settlementApi = createSettlementRequestApiClient(request);

  try {
    if (intent === "preview-payout") {
      if (!actor.permissions.includes("payouts.request")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to") };
      }
      const amount = normalizeQuickAmount(formData);
      const note = formData.get("note") ? String(formData.get("note")) : null;
      const preview = await settlementApi.previewPayout({ amount });
      return {
        confirmation: {
          amount,
          note,
          preview,
        },
      };
    }

    if (intent === "edit-payout") {
      if (!actor.permissions.includes("payouts.request")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to.2") };
      }
      return {
        draft: {
          amount: String(formData.get("amount") ?? ""),
          note: formData.get("note") ? String(formData.get("note")) : null,
        },
      };
    }

    if (intent === "confirm-payout") {
      if (!actor.permissions.includes("payouts.request")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to.3") };
      }
      const result = (await settlementApi.createPayout({
        amount: formData.get("amount"),
        destinationReference: null,
        note: formData.get("note") || null,
      })) as Readonly<{ id: string }>;

      return redirect(
        navigateAfterWrite(result, `/account/payouts/${result.id}?requested=1`, {
          telemetry: ACCOUNT_PAYOUTS_POST_WRITE_TELEMETRY,
        }),
      );
    }

    if (intent === "start-payout-setup") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to.4") };
      }
      return redirect("/account/payouts/setup");
    }

    if (intent === "refresh-payout-setup") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to.5") };
      }
      const refreshedPayoutReadiness = await settlementApi.refreshPayoutSetup();
      return {
        refreshedPayoutReadiness,
        setupNotice: t("settlement.routes.marketplace.accountPayouts.payout.setup.status.was.refreshed"),
      };
    }

    if (intent === "manage-payout-account") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: t("settlement.routes.marketplace.accountPayouts.you.do.not.have.permission.to.6") };
      }
      return redirect("/account/payouts/setup?mode=manage");
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
  buildOpenGraphMeta({ title: t("settlement.routes.marketplace.accountPayouts.payouts.marketplace") });

export default function MarketplaceAccountPayoutsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as PayoutActionData | undefined;

  if (data.accountAccessRequired) {
    return (
      <AccountAccessRequiredPage
        title={data.accountAccessRequired.title}
        description={data.accountAccessRequired.description}
        returnTo={data.accountAccessRequired.returnTo}
      />
    );
  }

  return (
    <SettlementPayoutListPage
      wallet={data.wallet as SettlementWalletRow}
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      payoutReadiness={actionData?.refreshedPayoutReadiness ?? (data.payoutReadiness as SettlementPayoutReadinessRow)}
      errorMessage={actionData?.error ?? null}
      payoutDraft={actionData?.draft ?? null}
      payoutConfirmation={actionData?.confirmation ?? null}
      canRequestPayouts={data.canRequestPayouts}
      canSetupPayouts={data.canSetupPayouts}
      setupNotice={actionData?.setupNotice ?? data.setupNotice}
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
        eyebrow={t("settlement.routes.marketplace.accountPayouts.account.access")}
        title={title}
        description={description}
      />
      <PageSection title={t("settlement.routes.marketplace.accountPayouts.next.step")}>
        <Card>
          <Stack gap={3}>
            <Text>{t("settlement.routes.marketplace.accountPayouts.use.an.account.with.payout.access")}</Text>
            <Stack direction="row" gap={2}>
              <LinkButton href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
                {t("settlement.routes.marketplace.accountPayouts.use.a.different.account")}
              </LinkButton>
              <LinkButton href="/account" tone="secondary">
                {t("settlement.routes.marketplace.accountPayouts.view.account")}
              </LinkButton>
            </Stack>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
