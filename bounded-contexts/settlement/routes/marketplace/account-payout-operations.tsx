import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  type SettlementProviderIdempotencyKeyRow,
  type SettlementPayoutRow,
  createSettlementRequestApiClient,
} from "../../support/request-support/api-client";
import { SettlementPayoutOperationsPage } from "../../features/payouts/ui/payout-operations-page";

type ReconciliationRunResult = Readonly<{
  checked: number;
  reconciled: number;
  ignored: number;
  skipped: number;
  errors: readonly Readonly<{ payoutId: string; message: string }>[];
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.reconcile",
  });

  const settlementApi = createSettlementRequestApiClient(request);
  const requestUrl = new URL(request.url);
  const filter = requestUrl.searchParams.get("filter") ?? "all";
  const query = filter === "all" ? "" : `filter=${encodeURIComponent(filter)}`;
  const [payouts, idempotencyKeys] = await Promise.all([
    settlementApi.listPayoutsNeedingReconciliation(query),
    settlementApi.listPayoutProviderIdempotencyKeys("limit=10"),
  ]);

  return { payouts, idempotencyKeys, filter };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "payouts.reconcile",
  });

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "run-reconciliation") {
    return null;
  }

  const settlementApi = createSettlementRequestApiClient(request);
  return settlementApi.runPayoutReconciliation({ limit: 100 });
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Payout Operations | Marketplace" });

export default function MarketplaceAccountPayoutOperationsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ReconciliationRunResult | null;

  return (
    <SettlementPayoutOperationsPage
      payouts={(data.payouts.items ?? []) as SettlementPayoutRow[]}
      idempotencyKeys={
        (data.idempotencyKeys.items ?? []) as SettlementProviderIdempotencyKeyRow[]
      }
      runResult={actionData}
      currentFilter={data.filter}
      lastCheckedAt={actionData ? new Date().toISOString() : null}
    />
  );
}
