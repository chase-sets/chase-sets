import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { SupportOrderLookup } from "../../features/support-requests/ui/contracts";
import { SupportRequestListPage } from "../../features/support-requests/ui/support-request-list-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "support.view",
  });
  const api = createSupportRequestRequestApiClient(request);
  const searchParams = new URL(request.url).searchParams;
  const orderId = searchParams.get("orderId");
  const role = searchParams.get("role");
  const [flows, buyerRequests, sellerRequests] = await Promise.all([
    api.listFlows(),
    api.listBuyerSupportRequests(),
    api.listSellerSupportRequests(),
  ]);
  let supportOrder: SupportOrderLookup | null = null;
  let lookupError: string | null = null;

  if (orderId) {
    try {
      supportOrder = await api.getSupportOrderContext(orderId, role);
    } catch (error) {
      lookupError =
        error instanceof Error ? error.message : t("support.routes.marketplace.accountSupport.lookup.failed");
    }
  }

  return {
    flows,
    buyerRequests,
    sellerRequests,
    lookupError,
    supportOrder,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "support.manage",
  });
  const api = createSupportRequestRequestApiClient(request);
  const formData = await request.formData();

  try {
    const result = await api.openSupportRequest({
      orderId: formValue(formData, "orderId"),
      flowType: formValue(formData, "flowType"),
      openedByRole: formValue(formData, "openedByRole"),
    });
    return redirect(`/account/support?opened=${encodeURIComponent(result.id)}`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("support.routes.marketplace.accountSupport.open.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("support.routes.marketplace.accountSupport.support.marketplace") });

export default function MarketplaceAccountSupportRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const openedSupportRequestId = searchParams.get("opened");

  return (
    <SupportRequestListPage
      flows={data.flows.items}
      buyerRequests={data.buyerRequests.items}
      sellerRequests={data.sellerRequests.items}
      actionError={actionData?.error ?? null}
      lookupError={data.lookupError}
      openedSupportRequestId={openedSupportRequestId}
      supportOrder={data.supportOrder}
    />
  );
}
