import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { PricingBulkRepricePage } from "../../features/bulk-reprice-ingestion/ui/bulk-reprice-page";
import { loader } from "../../support/route-support/bulk-reprice/loader";
import { action } from "../../support/route-support/bulk-reprice/action";

export { loader } from "../../support/route-support/bulk-reprice/loader";
export { action } from "../../support/route-support/bulk-reprice/action";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.bulkReprice.bulk.reprice.marketplace"),
    description: t("pricing.routes.marketplace.bulkReprice.upload.a.csv.to.reprice"),
  });

// Bulk reprice ingestion (m113) is a removable feature: this route file is
// one of the documented mount points in features/bulk-reprice-ingestion/REMOVAL.md.
export default function MarketplaceBulkRepriceRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <PricingBulkRepricePage
      activeJobId={data.activeJobId}
      initialActiveJob={data.activeJob}
      message={actionData && "message" in actionData ? String(actionData.message ?? "") : null}
      errorMessage={actionData && "error" in actionData ? String(actionData.error ?? "") : null}
    />
  );
}
