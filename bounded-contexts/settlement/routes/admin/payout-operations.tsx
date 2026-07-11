import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
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
  const settlementApi = createSettlementRequestApiClient(request);
  const requestUrl = new URL(request.url);
  const filter = requestUrl.searchParams.get("filter") ?? "all";
  const query = filter === "all" ? "" : `filter=${encodeURIComponent(filter)}`;
  const [payouts, idempotencyKeys, payoutReadiness] = await Promise.all([
    settlementApi.listPayoutsNeedingReconciliation(query),
    settlementApi.listPayoutProviderIdempotencyKeys("limit=10"),
    settlementApi.getPayoutReadiness(),
  ]);

  return {
    payouts,
    idempotencyKeys,
    payoutReadiness,
    filter,
    marketplaceOrigin: resolveSettlementMarketplaceOrigin(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "run-reconciliation") {
    return null;
  }

  const settlementApi = createSettlementRequestApiClient(request);
  return settlementApi.runPayoutReconciliation({ limit: 100 });
}

export const meta: MetaFunction = () => [
  { title: t("settlement.routes.admin.payoutOperations.payout.operations.settlement.admin") },
];

export default function AdminPayoutOperationsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ReconciliationJobSnapshot | null;

  return (
    <SettlementPayoutOperationsPage
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      idempotencyKeys={(data.idempotencyKeys.items ?? []) as SettlementProviderIdempotencyKeyRow[]}
      payoutReadiness={data.payoutReadiness as SettlementPayoutReadinessRow}
      runResult={actionData}
      currentFilter={data.filter}
      lastCheckedAt={actionData ? new Date().toISOString() : null}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
