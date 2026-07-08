export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCheckoutApi } from "./api";
import { createCheckoutCartMcpHandlers } from "./features/cart/api/mcp";
import { buildCheckoutCatalogProjectionHandlers } from "./features/cart/integrations/catalog/catalog-projection";
import { buildCheckoutIdentitySellerAccountsProjectionHandlers } from "./features/cart/integrations/identity/identity-projection";
import { buildCheckoutInventorySupplyProjectionHandlers } from "./features/cart/integrations/inventory/inventory-projection";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "./features/cart/integrations/marketplace/marketplace-projection";
import { buildCheckoutReputationSellerReviewsProjectionHandlers } from "./features/cart/integrations/reputation/reputation-projection";
import { buildCheckoutSellListProjectionHandlers } from "./features/sell-list/read-model/projection";
import { buildCheckoutPaymentAffordanceProjectionHandlers } from "./features/sessions/integrations/payments/payment-affordance-projection";
import { buildCheckoutPaymentSummaryProjectionHandlers } from "./features/sessions/integrations/payments/payment-summary-projection";
import {
  createCheckoutServices,
  type CheckoutHostPorts,
  type CheckoutServices,
} from "./support/runtime-support/services";
import { checkoutSchemaMigrations, checkoutSchemaSql } from "./support/runtime-support/schema";
import { seedCheckoutDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<CheckoutServices, PgTransactionalPool, CheckoutHostPorts>({
  manifest: contextManifest,
  schemaSql: checkoutSchemaSql,
  schemaMigrations: checkoutSchemaMigrations,
  createServices: (pool, options) => createCheckoutServices(pool, options),
  buildApis: (services) => [buildCheckoutApi(services)],
  buildMcpHandlers: (services) => {
    const missingCheckoutMcpService = () => {
      throw new Error("Checkout MCP service dependency is not available.");
    };
    return createCheckoutCartMcpHandlers({
      cart: services.cart,
      sessions: services.sessions ?? { setShippingAddress: missingCheckoutMcpService },
      listSavedShippingAddresses: services.sellList?.listShipFromAddresses ?? missingCheckoutMcpService,
    });
  },
  projectionHandlerSets: (services) => services.projectors,
  seed: seedCheckoutDatabase,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "checkout",
      manifest: contextManifest,
      handlers: {
        "catalog.checkout-catalog-item-projection": () => buildCheckoutCatalogProjectionHandlers(services.db),
        "catalog.checkout-marketplace-listing-options-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        },
        "marketplace.checkout-marketplace-listing-options-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        },
        "marketplace.checkout-seller-accounts-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutReputationSellerReviewsProjectionHandlers(services.db),
        },
        "marketplace.checkout.sell-list-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutSellListProjectionHandlers(services.db),
        },
        "settlement.checkout.sell-list-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutSellListProjectionHandlers(services.db),
        },
        "checkout.checkout.sell-list-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutSellListProjectionHandlers(services.db),
        },
        "inventory.checkout-inventory-supply-projection": {
          buildHandlers: () => buildCheckoutInventorySupplyProjectionHandlers(services.db),
        },
        "identity.checkout-seller-accounts-projection": {
          buildHandlers: () => buildCheckoutIdentitySellerAccountsProjectionHandlers(services.db),
        },
        "payments.checkout.payment-summary-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutPaymentSummaryProjectionHandlers(services.db),
        },
        "payments.checkout.payment-affordance-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutPaymentAffordanceProjectionHandlers(services.db),
        },
      },
    }),
});
