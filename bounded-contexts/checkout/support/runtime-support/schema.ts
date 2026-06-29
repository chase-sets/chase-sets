import { checkoutCatalogProjectionSchemaSql } from "../../features/cart/integrations/catalog/catalog-schema";
import { checkoutSellerAccountsSchemaSql } from "../../features/cart/integrations/identity/identity-schema";
import { checkoutInventorySupplySchemaSql } from "../../features/cart/integrations/inventory/inventory-schema";
import { checkoutMarketplaceSellerOptionsSchemaSql } from "../../features/cart/integrations/marketplace/marketplace-schema";
import { checkoutSellerAccountReviewsSchemaSql } from "../../features/cart/integrations/reputation/reputation-schema";
import { checkoutCartSchemaSql } from "../../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../../features/sell-list/read-model/schema";
import { checkoutPaymentAffordanceSchemaSql } from "../../features/sessions/integrations/payments/payment-affordance-schema";
import { checkoutPaymentSummarySchemaSql } from "../../features/sessions/integrations/payments/payment-summary-schema";
import { checkoutSessionSchemaSql } from "../../features/sessions/read-model/schema";

export const checkoutSchemaSql = [
  checkoutCatalogProjectionSchemaSql,
  checkoutMarketplaceSellerOptionsSchemaSql,
  checkoutInventorySupplySchemaSql,
  checkoutSellerAccountsSchemaSql,
  checkoutSellerAccountReviewsSchemaSql,
  checkoutCartSchemaSql,
  checkoutSellListSchemaSql,
  checkoutPaymentAffordanceSchemaSql,
  checkoutPaymentSummarySchemaSql,
  checkoutSessionSchemaSql,
].join("\n");
