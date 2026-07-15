import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { MetaFunction } from "react-router";
import { SellerDeskIndexPage } from "../features/seller-desk/ui/seller-desk-index-page";

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("marketplace.features.sellerDesk.ui.index.meta.title") });

export default function MarketplaceAccountDeskRoute() {
  return <SellerDeskIndexPage />;
}
