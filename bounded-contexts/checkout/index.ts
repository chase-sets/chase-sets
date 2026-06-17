export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCheckoutApi } from "./api";
import { buildCheckoutCatalogProjectionHandlers } from "./features/cart/integrations/catalog/catalog-projection";
import { buildCheckoutInventorySupplyProjectionHandlers } from "./features/cart/integrations/inventory/inventory-projection";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "./features/cart/integrations/marketplace/marketplace-projection";
import {
  createCheckoutServices,
  type CheckoutHostPorts,
  type CheckoutServices,
} from "./support/runtime-support/services";
import { checkoutSchemaSql } from "./support/runtime-support/schema";
import { seedCheckoutDatabase } from "./support/runtime-support/seed";

export const module = defineBoundedContextModule<CheckoutServices, PgTransactionalPool, CheckoutHostPorts>({
  manifest: contextManifest,
  schemaSql: checkoutSchemaSql,
  createServices: (pool, options) => createCheckoutServices(pool, options),
  buildApis: (services) => [buildCheckoutApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  seed: seedCheckoutDatabase,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "checkout",
      manifest: contextManifest,
      handlers: {
        "catalog.checkout-catalog-item-projection": () => buildCheckoutCatalogProjectionHandlers(services.db),
        "marketplace.checkout-marketplace-seller-options-projection": () =>
          buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        "inventory.checkout-marketplace-seller-options-projection": {
          subscriptionName: "checkout.inventory-seller-options-supply-projection",
          buildHandlers: () => buildCheckoutInventorySupplyProjectionHandlers(services.db),
        },
      },
    }),
});
