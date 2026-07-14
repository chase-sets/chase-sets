import { useEffect } from "react";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useRevalidator } from "react-router";
import { ScopeSyncBatchPage } from "../../features/scope-sync-batches/ui/scope-sync-batch-page";
import {
  action,
  loader,
  type ScopeSyncBatchRouteActionData,
} from "../../support/route-support/admin-scope-sync-batches/scope-sync-batches-route";

export { action, loader } from "../../support/route-support/admin-scope-sync-batches/scope-sync-batches-route";

export const meta: MetaFunction = () => [{ title: "Scope Sync Batches | Catalog admin" }];

export default function ScopeSyncBatchesRoute() {
  const { batch } = useLoaderData<typeof loader>();
  const actionData = useActionData<ScopeSyncBatchRouteActionData>();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!batch || !["queued", "running"].includes(batch.status)) return;
    const timer = window.setInterval(() => revalidator.revalidate(), 2_000);
    return () => window.clearInterval(timer);
  }, [batch, revalidator]);
  return <ScopeSyncBatchPage preview={actionData?.preview ?? null} batch={batch} error={actionData?.error ?? null} />;
}
