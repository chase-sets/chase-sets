import { t } from "@chase-sets/localization";
import type {
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type {
  FulfillmentPackingSlip,
  FulfillmentPackingSlipFormat,
} from "../../support/request-support/api-client";
import { createFulfillmentRequestApiClient } from "../../support/request-support/api-client";
import { FulfillmentPackingSlipPrintPage } from "../../features/shipments/ui/packing-slip-page";

const packingSlipFormats = new Set<FulfillmentPackingSlipFormat>([
  "letter",
  "thermal-4x6",
]);

function parseShipmentIds(url: URL) {
  return Array.from(
    new Set(
      [
        ...url.searchParams.getAll("shipmentIds"),
        url.searchParams.get("shipmentIds") ?? "",
      ]
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function parseFormat(url: URL): FulfillmentPackingSlipFormat {
  const format = url.searchParams.get("format") ?? "letter";

  return packingSlipFormats.has(format as FulfillmentPackingSlipFormat)
    ? format as FulfillmentPackingSlipFormat
    : "letter";
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "fulfillment.view",
  });
  const url = new URL(request.url);
  const shipmentIds = parseShipmentIds(url);
  if (shipmentIds.length === 0) {
    throw new Response(t("fulfillment.routes.marketplace.accountSaleShipmentPackingSlips.no.shipments.selected"), { status: 400 });
  }

  const api = createFulfillmentRequestApiClient(request);
  const result = await api.listSellerPackingSlips(shipmentIds);

  return {
    format: parseFormat(url),
    slips: result.items,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("fulfillment.routes.marketplace.accountSaleShipmentPackingSlips.packing.slips.marketplace") });

export default function MarketplaceAccountSaleShipmentPackingSlipsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <FulfillmentPackingSlipPrintPage
      format={data.format as FulfillmentPackingSlipFormat}
      slips={data.slips as FulfillmentPackingSlip[]}
    />
  );
}
