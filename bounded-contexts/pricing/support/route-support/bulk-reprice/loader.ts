import type { LoaderFunctionArgs } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../request-support/api-client";
import type { BulkRepriceJobStatus } from "../../../features/bulk-reprice-ingestion/api/runtime";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "listings.manage",
  });
  const api = createPricingRequestApiClient(request);
  const activeJobId = new URL(request.url).searchParams.get("jobId") ?? "";
  const activeJob = activeJobId ? await loadActiveBulkRepriceJob(api, activeJobId) : null;

  return { activeJobId, activeJob };
}

async function loadActiveBulkRepriceJob(
  api: ReturnType<typeof createPricingRequestApiClient>,
  activeJobId: string,
): Promise<BulkRepriceJobStatus | null> {
  try {
    return await api.getBulkRepriceJob(activeJobId);
  } catch (error) {
    if (error instanceof PricingApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
