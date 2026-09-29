import { defineBcProjectionGroupReset, type BcProjectionGroup } from "@chase-sets/bounded-context-module";
import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { resetProductMeasurePublicationParts, type PgQueryable } from "@chase-sets/event-core-postgres";
export { default as contextManifest } from "./context.json" with { type: "json" };

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { checkoutRetentionSchemaMigrations, checkoutRetentionSweeps } from "./support/runtime-support/retention-policy";
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
import { checkoutUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { inspectCheckoutSeedState, seedCheckoutDatabase } from "./support/runtime-support/seed";

const baseModule = defineBoundedContextModule<CheckoutServices, PgTransactionalPool, CheckoutHostPorts>({
  manifest: contextManifest,
  schemaSql: checkoutSchemaSql,
  schemaMigrations: [
    ...checkoutUnloggedProjectionSchemaMigrations,
    ...checkoutSchemaMigrations,
    ...checkoutRetentionSchemaMigrations,
  ],
  retentionSweeps: checkoutRetentionSweeps,
  createServices: (pool, options) => createCheckoutServices(pool, options),
  buildApis: (services) => [
    { mountPath: "/api/marketplace", contextMountOrdinal: 1, router: buildCheckoutApi(services) },
  ],
  buildMcpHandlers: (services) => {
    const missingCheckoutMcpService = () => {
      throw new Error("Checkout MCP service dependency is not available.");
    };
    return createCheckoutCartMcpHandlers({
      cart: services.cart,
      sessions: services.sessions ?? {
        cancelSession: missingCheckoutMcpService,
        getSession: missingCheckoutMcpService,
        setShippingAddress: missingCheckoutMcpService,
      },
      listSavedShippingAddresses: services.sellList?.listShipFromAddresses ?? missingCheckoutMcpService,
    });
  },
  projectionHandlerSets: (services) => services.projectors,
  seed: seedCheckoutDatabase,
  inspectSeedState: (pool) => inspectCheckoutSeedState(pool),
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "checkout",
      manifest: contextManifest,
      handlers: {
        "catalog.checkout-catalog-item-projection": () => buildCheckoutCatalogProjectionHandlers(services.db),
        "catalog.checkout-marketplace-listing-options-projection": () =>
          buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        "marketplace.checkout-marketplace-listing-options-projection": () =>
          buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        "ordering.checkout-marketplace-listing-options-projection": () =>
          buildCheckoutMarketplaceSellerOptionsProjectionHandlers(services.db),
        "marketplace.checkout-seller-accounts-projection": () =>
          buildCheckoutReputationSellerReviewsProjectionHandlers(services.db),
        "marketplace.checkout.sell-list-projection": () => buildCheckoutSellListProjectionHandlers(services.db),
        "settlement.checkout.sell-list-projection": () => buildCheckoutSellListProjectionHandlers(services.db),
        "checkout.checkout.sell-list-projection": () => buildCheckoutSellListProjectionHandlers(services.db),
        "inventory.checkout-inventory-supply-projection": () =>
          buildCheckoutInventorySupplyProjectionHandlers(services.db),
        "identity.checkout-seller-accounts-projection": () =>
          buildCheckoutIdentitySellerAccountsProjectionHandlers(services.db),
        "payments.checkout.payment-summary-projection": () =>
          buildCheckoutPaymentSummaryProjectionHandlers(services.db),
        "payments.checkout.payment-affordance-projection": () =>
          buildCheckoutPaymentAffordanceProjectionHandlers(services.db),
      },
    }),
});

export const module = {
  ...baseModule,
  buildProjectionGroups(this: Pick<typeof baseModule, "projectionGroups">): readonly BcProjectionGroup[] {
    return (this.projectionGroups ?? []).map((group) =>
      group.projectionName === "checkout-marketplace-listing-options-projection"
        ? {
            ...group,
            reset: defineBcProjectionGroupReset(async (db: PgQueryable) => {
              if (group.resetStrategy === "truncate-owned-tables") {
                const ownedTables = group.ownedTables.map((table) => {
                  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
                    throw new Error(`Invalid checkout projection table name '${table}'.`);
                  }
                  return table;
                });
                if (ownedTables.length > 0) await db.query(`TRUNCATE TABLE ${ownedTables.join(", ")}`);
              } else if (group.resetStrategy !== "replay-only") {
                throw new Error(`Unsupported listing-options reset strategy '${group.resetStrategy}'.`);
              }
              await resetProductMeasurePublicationParts(
                db,
                createCheckpointKey(
                  contextManifest.eventSubscriptions.find(
                    (subscription) =>
                      subscription.sourceContextName === "catalog" &&
                      subscription.projectionName === group.projectionName,
                  )!,
                ),
              );
            }),
          }
        : group,
    );
  },
};
