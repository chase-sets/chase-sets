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
  }>;
}>;

function normalizeQuickAmount(formData: FormData) {
  return resolvePayoutAmountSelection({
    amount: String(formData.get("amount") ?? ""),
    shortcut: String(formData.get("quickAmount") ?? ""),
    availableAmount: String(formData.get("availableAmount") ?? "0"),
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  if (
    requestUrl.searchParams.get("setup") === "returned" ||
    requestUrl.searchParams.get("setup") === "refresh"
  ) {
    await requireActorFromAuthApi({
      request,
      permission: "payouts.setup",
    });
    await createSettlementRequestApiClient(request).refreshPayoutSetup();
    return redirect("/account/payouts");
  }

  const actor = await requireActorFromAuthApi({
    request,
    permission: "payouts.view",
  });
  const settlementApi = createSettlementRequestApiClient(request);

  const [wallet, payouts, payoutReadiness] = await Promise.all([
    settlementApi.getWallet(),
    settlementApi.listPayouts(),
    settlementApi.getPayoutReadiness(),
  ]);
  return {
    wallet,
    payouts,
    payoutReadiness,
    canRequestPayouts: actor.permissions.includes("payouts.request"),
    canSetupPayouts: actor.permissions.includes("payouts.setup"),
    canReconcilePayouts: actor.permissions.includes("payouts.reconcile"),
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
        return { error: "You do not have permission to request payouts." };
      }
      const amount = normalizeQuickAmount(formData);
      const note = formData.get("note") ? String(formData.get("note")) : null;
      return {
        confirmation: {
          amount,
          note,
        },
      };
    }

    if (intent === "edit-payout") {
      if (!actor.permissions.includes("payouts.request")) {
        return { error: "You do not have permission to request payouts." };
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
        return { error: "You do not have permission to request payouts." };
      }
      const result = (await settlementApi.createPayout({
        amount: formData.get("amount"),
        destinationReference: null,
        note: formData.get("note") || null,
      })) as Readonly<{ id: string }>;

      return redirect(`/account/payouts/${result.id}?requested=1`);
    }

    if (intent === "start-payout-setup") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: "You do not have permission to update payout setup." };
      }
      const result = await settlementApi.createPayoutSetupOnboardingSession({
        returnUrl: new URL("/account/payouts?setup=returned", request.url).toString(),
        refreshUrl: new URL("/account/payouts?setup=refresh", request.url).toString(),
      });

      return redirect(result.url);
    }

    if (intent === "refresh-payout-setup") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: "You do not have permission to update payout setup." };
      }
      await settlementApi.refreshPayoutSetup();
      return redirect("/account/payouts");
    }

    if (intent === "manage-payout-account") {
      if (!actor.permissions.includes("payouts.setup")) {
        return { error: "You do not have permission to update payout setup." };
      }
      const result = await settlementApi.createPayoutAccountManagementSession({
        returnUrl: new URL("/account/payouts?setup=returned", request.url).toString(),
      });

      return redirect(result.url);
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
      wallet={data.wallet as SettlementWalletRow}
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
      errorMessage={actionData?.error ?? null}
      payoutDraft={actionData?.draft ?? null}
      payoutConfirmation={actionData?.confirmation ?? null}
      canRequestPayouts={data.canRequestPayouts}
      canSetupPayouts={data.canSetupPayouts}
      showOperations={data.canReconcilePayouts}
    />
  );
}
