import { checkoutCatalogProjectionSchemaSql } from "../../features/cart/integrations/catalog/catalog-schema";
import { checkoutInventorySupplySchemaSql } from "../../features/cart/integrations/inventory/inventory-schema";
import { checkoutMarketplaceSellerOptionsSchemaSql } from "../../features/cart/integrations/marketplace/marketplace-schema";
import { checkoutCartSchemaSql } from "../../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../../features/sell-list/read-model/schema";
import { checkoutSessionSchemaSql } from "../../features/sessions/read-model/schema";

export const checkoutSchemaSql = [
  checkoutCatalogProjectionSchemaSql,
  checkoutMarketplaceSellerOptionsSchemaSql,
  checkoutInventorySupplySchemaSql,
  checkoutCartSchemaSql,
  checkoutSellListSchemaSql,
  checkoutSessionSchemaSql,
].join("\n");
