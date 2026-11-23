import { PublicHelpArticlePage } from "@chase-sets/public-presence/web";
import { createSalesFeesRoute } from "../../features/marketplace-sales-fee/ui/routes/sales-fees";

export { headers, loader, meta } from "../../features/marketplace-sales-fee/ui/routes/sales-fees";
export default createSalesFeesRoute(PublicHelpArticlePage);
