export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCheckoutApi } from "./api";
import { buildCheckoutCatalogProjectionHandlers } from "./features/cart/integrations/catalog/catalog-projection";
import { buildCheckoutIdentitySellerAccountsProjectionHandlers } from "./features/cart/integrations/identity/identity-projection";
import { buildCheckoutInventorySupplyProjectionHandlers } from "./features/cart/integrations/inventory/inventory-projection";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "./features/cart/integrations/marketplace/marketplace-projection";
import { buildCheckoutReputationSellerReviewsProjectionHandlers } from "./features/cart/integrations/reputation/reputation-projection";
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
        "catalog.checkout-marketplace-seller-options-projection": {
          filterToEventTypes: true,
          buildHandlers: () => buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        },
        // The marketplace subscription feeds this projection both the listing
        // lifecycle handlers and — because the `reputation.review.*` events are
        // emitted by the marketplace context — the seller-review reputation
        // handlers, composed under the single marketplace -> projection key the
        // manifest builder allows. The event-type keys are disjoint
        // (`marketplace.*` vs `reputation.*`), so the spread cannot collide.
        "marketplace.checkout-marketplace-seller-options-projection": {
          filterToEventTypes: true,
          buildHandlers: () => ({
            ...buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
            ...buildCheckoutReputationSellerReviewsProjectionHandlers(services.db),
          }),
        },
        "inventory.checkout-marketplace-seller-options-projection": {
          subscriptionName: "checkout.inventory-seller-options-supply-projection",
          buildHandlers: () => buildCheckoutInventorySupplyProjectionHandlers(services.db),
        },
        "identity.checkout-marketplace-seller-options-projection": {
          subscriptionName: "checkout.identity-seller-options-accounts-projection",
          buildHandlers: () => buildCheckoutIdentitySellerAccountsProjectionHandlers(services.db),
        },
      },
    }),
});
