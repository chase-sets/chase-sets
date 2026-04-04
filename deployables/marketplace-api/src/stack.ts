import { module as catalogModule } from "@chase-sets/catalog";
import { module as discoveryModule, type DiscoveryServices } from "@chase-sets/discovery";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule, type FulfillmentServices } from "@chase-sets/fulfillment";
import { module as identityModule } from "@chase-sets/identity";
import {
  module as inventoryModule,
  type InventoryServices,
} from "@chase-sets/inventory";
import { createInventoryReservationGateway } from "@chase-sets/inventory/integration";
import {
  module as marketplaceModule,
  type MarketplaceServices,
} from "@chase-sets/marketplace";
import { createMarketplaceSupplyResolver } from "@chase-sets/marketplace/integration";
import {
  createOrderingModule,
  type OrderingServices,
} from "@chase-sets/ordering";
import { createOrderSnapshotReader } from "@chase-sets/ordering/integration";
import {
  createPaymentsModule,
  type PaymentProcessorGateway,
  type PaymentsServices,
} from "@chase-sets/payments";
import { module as reputationModule, type ReputationServices } from "@chase-sets/reputation";
import { module as settlementModule, type SettlementServices } from "@chase-sets/settlement";
import { composeApiModules } from "@chase-sets/bounded-context-runtime";

export type MarketplaceApiStackServices = Readonly<{
  discovery: DiscoveryServices;
  fulfillment: FulfillmentServices;
  inventory: InventoryServices;
  marketplace: MarketplaceServices;
  ordering: OrderingServices;
  payments: PaymentsServices;
  reputation: ReputationServices;
  settlement: SettlementServices;
}>;

export function composeMarketplaceApiStack(
  pool: PgTransactionalPool,
  options: Readonly<{
    processorGateway: PaymentProcessorGateway;
  }>,
) {
  const baseModules = composeApiModules(pool, [
    { module: discoveryModule, ports: undefined },
    { module: inventoryModule, ports: undefined },
    { module: marketplaceModule, ports: undefined },
  ] as const);
  const [discoveryEntry, inventoryEntry, marketplaceEntry] = baseModules;

  const orderingModule = createOrderingModule({
    supplyResolver: createMarketplaceSupplyResolver(marketplaceEntry.services),
    inventoryReservations: createInventoryReservationGateway(inventoryEntry.services),
  });
  const orderingModules = composeApiModules(pool, [
    { module: orderingModule, ports: undefined },
  ] as const);
  const [orderingEntry] = orderingModules;

  const paymentsModule = createPaymentsModule({
    processorGateway: options.processorGateway,
    getOrderSnapshot: createOrderSnapshotReader(orderingEntry.services),
  });
  const remainingModules = composeApiModules(pool, [
    { module: catalogModule, ports: undefined },
    { module: identityModule, ports: undefined },
    { module: fulfillmentModule, ports: undefined },
    { module: paymentsModule, ports: undefined },
    { module: reputationModule, ports: undefined },
    { module: settlementModule, ports: undefined },
  ] as const);
  const [, , fulfillmentEntry, paymentsEntry, reputationEntry, settlementEntry] = remainingModules;

  return {
    mountedModules: [
      ...baseModules,
      ...orderingModules,
      ...remainingModules,
    ] as const,
    services: {
      discovery: discoveryEntry.services,
      fulfillment: fulfillmentEntry.services,
      inventory: inventoryEntry.services,
      marketplace: marketplaceEntry.services,
      ordering: orderingEntry.services,
      payments: paymentsEntry.services,
      reputation: reputationEntry.services,
      settlement: settlementEntry.services,
    } satisfies MarketplaceApiStackServices,
  };
}
