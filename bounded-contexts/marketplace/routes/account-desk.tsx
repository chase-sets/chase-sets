import { useLoaderData } from "react-router";
import { SellerDeskHomePage } from "../features/seller-desk/ui/seller-desk-home-page";
import { loader } from "../support/route-support/account-desk/account-desk-loader";

export { loader, meta } from "../support/route-support/account-desk/account-desk-loader";

// Seller Desk home (`/account/desk`) — the seller's landing surface. A thin
// route adapter: it re-exports the loader/meta and renders the Desk home from
// the composed attention queue and KPI band.
export default function MarketplaceAccountDeskRoute() {
  const { queue, kpis } = useLoaderData<typeof loader>();

  return <SellerDeskHomePage queue={queue} kpis={kpis} />;
}
