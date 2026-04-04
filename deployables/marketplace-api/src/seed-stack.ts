import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { seedCatalogDatabase } from "@chase-sets/catalog";
import { createDiscoveryServices } from "@chase-sets/discovery";
import {
  createFulfillmentServices,
  seedFulfillmentDatabase,
} from "@chase-sets/fulfillment";
import { seedIdentityDatabase } from "@chase-sets/identity";
import {
  createInventoryServices,
  seedInventoryDatabase,
} from "@chase-sets/inventory";
import { createInventoryReservationGateway } from "@chase-sets/inventory/integration";
import {
  createMarketplaceServices,
  seedMarketplaceDatabase,
} from "@chase-sets/marketplace";
import { createMarketplaceSupplyResolver } from "@chase-sets/marketplace/integration";
import {
  createOrderingServices,
  seedOrderingDatabase,
} from "@chase-sets/ordering";
import { createOrderSnapshotReader } from "@chase-sets/ordering/integration";
import {
  createFakePaymentProcessorGateway,
  createPaymentsServices,
  seedPaymentsDatabase,
} from "@chase-sets/payments";
import { createReputationServices, seedReputationDatabase } from "@chase-sets/reputation";
import { createSettlementServices, seedSettlementDatabase } from "@chase-sets/settlement";

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function seedMarketplaceStack(pool: PgTransactionalPool) {
  await seedIdentityDatabase(pool);
  await seedCatalogDatabase(pool);
  await seedInventoryDatabase(pool);
  await seedMarketplaceDatabase(pool);
  await seedOrderingDatabase(pool);
  await seedPaymentsDatabase(pool);
  await seedFulfillmentDatabase(pool);
  await seedReputationDatabase(pool);
  await seedSettlementDatabase(pool);

  const discovery = createDiscoveryServices(pool);
  const inventory = createInventoryServices(pool);
  const marketplace = createMarketplaceServices(pool);
  const ordering = createOrderingServices(pool, {
    supplyResolver: createMarketplaceSupplyResolver(marketplace),
    inventoryReservations: createInventoryReservationGateway(inventory),
  });
  const payments = createPaymentsServices(pool, {
    processorGateway: createFakePaymentProcessorGateway(),
    getOrderSnapshot: createOrderSnapshotReader(ordering),
  });
  const fulfillment = createFulfillmentServices(pool);
  const reputation = createReputationServices(pool);
  const settlement = createSettlementServices(pool);

  await drainProjectors([
    ...discovery.projectors,
    ...inventory.projectors,
    ...marketplace.projectors,
    ...payments.projectors,
    ...fulfillment.projectors,
    ...ordering.projectors,
    ...reputation.projectors,
    ...settlement.projectors,
  ]);
}

