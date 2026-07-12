import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient } from "../../request-support/api-client";

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "listings.manage",
  });
  const api = createPricingRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "upload-bulk-reprice") {
      const file = formData.get("file");
      const csvText = file instanceof File ? await file.text() : String(formData.get("csvText") ?? "");
      const sourceFilename = file instanceof File ? file.name : null;
      const job = await api.createBulkRepriceJob({ csvText, sourceFilename });
      return redirect(`/account/bulk-reprice?jobId=${encodeURIComponent(job.jobId)}`);
    }

    if (intent === "cancel-bulk-reprice") {
      const jobId = String(formData.get("jobId") ?? "");
      const job = await api.cancelBulkRepriceJob(jobId);
      return redirect(`/account/bulk-reprice?jobId=${encodeURIComponent(job.jobId)}`);
    }

    return {
      error: t("pricing.routes.marketplace.bulkReprice.unknown.action"),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("pricing.routes.marketplace.bulkReprice.action.failed"),
    };
  }
}
