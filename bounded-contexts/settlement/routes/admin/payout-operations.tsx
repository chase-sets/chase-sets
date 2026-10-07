import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type SettlementProviderIdempotencyKeyRow,
  type SettlementPayoutRow,
  type SettlementPayoutReadinessRow,
  createSettlementRequestApiClient,
} from "../../support/request-support/api-client";
import { SettlementPayoutOperationsPage } from "../../features/payouts/ui/payout-operations-page";

type ReconciliationJobSnapshot = Readonly<{
  jobId: string;
  status: string;
  progress: Readonly<{
    phase: string;
    completed: number;
    total: number;
    message: string | null;
  }>;
  result: Readonly<{
    checked: number;
    reconciled: number;
    ignored: number;
    skipped: number;
    errors: readonly Readonly<{ payoutId: string; message: string }>[];
  }> | null;
  errorMessage?: string | null;
}>;

export function resolveSettlementMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const canReconcile = actor?.permissions.includes("payouts.reconcile") ?? false;
  const settlementApi = createSettlementRequestApiClient(request);
  const requestUrl = new URL(request.url);
  const filter = requestUrl.searchParams.get("filter") ?? "all";
  const query = filter === "all" ? "" : `filter=${encodeURIComponent(filter)}`;
  const [payouts, idempotencyKeys, payoutReadiness] = await Promise.all([
    settlementApi.listPayoutsNeedingReconciliation(query),
    canReconcile ? settlementApi.listPayoutProviderIdempotencyKeys("limit=10") : null,
    canReconcile ? settlementApi.getPayoutReadiness() : null,
  ]);

  return {
    canReconcile,
    payouts,
    idempotencyKeys,
    payoutReadiness,
    filter,
    marketplaceOrigin: resolveSettlementMarketplaceOrigin(),
  };
}

export const action = defineFormAction({
  intents: {
    "run-reconciliation": ({ request }) =>
      createSettlementRequestApiClient(request).runPayoutReconciliation({ limit: 100 }),
  },
  onUnknownIntent: () => null,
});

export const meta: MetaFunction = () => [
  { title: t("settlement.routes.admin.payoutOperations.payout.operations.settlement.admin") },
];

export default function AdminPayoutOperationsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ReconciliationJobSnapshot | null;

  return (
    <SettlementPayoutOperationsPage
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      canReconcile={data.canReconcile}
      idempotencyKeys={data.idempotencyKeys?.items as SettlementProviderIdempotencyKeyRow[] | undefined}
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow | null}
      runResult={actionData}
      currentFilter={data.filter}
      lastCheckedAt={actionData ? new Date().toISOString() : null}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
