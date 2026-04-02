import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { seedCatalogDatabase } from "@chase-sets/catalog-authoring";
import { createDiscoveryServices } from "@chase-sets/discovery";
import {
  createFulfillmentServices,
  seedFulfillmentDatabase,
} from "@chase-sets/fulfillment";
import { seedIdentityDatabase } from "@chase-sets/identity";
import { createInventoryServices, seedInventoryDatabase } from "@chase-sets/inventory";
import { createMarketplaceServices, seedMarketplaceDatabase } from "@chase-sets/marketplace-context";
import { createOrderingServices, seedOrderingDatabase } from "@chase-sets/ordering";
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
    inventoryReservations: {
      createReservation: async ({ sellerAccountId, inventoryRecordId, quantity, reason, notes, context }) => {
        const result = await inventory.holds.createHold(
          {
            accountId: sellerAccountId,
            recordId: inventoryRecordId,
            quantity,
            reason,
            notes,
          },
          context as never,
        );

        return {
          holdId: result.holdId,
          inventoryRecordId,
          sellerAccountId,
          quantity,
        };
      },
      releaseReservation: async ({ sellerAccountId, holdId, context }) => {
        await inventory.holds.releaseHold(
          {
            accountId: sellerAccountId,
            holdId,
          },
          context as never,
        );
      },
    },
  });
  const payments = createPaymentsServices(pool, {
    processorGateway: createFakePaymentProcessorGateway(),
    getOrderSnapshot: async (orderId, buyerAccountId) => {
      const order = await ordering.orders.getBuyerOrder(orderId, buyerAccountId);
      return order
        ? {
            orderId: order.order_id as never,
            buyerAccountId: order.buyer_account_id as never,
            totalAmount: order.total_amount,
            status: order.status,
          }
        : null;
    },
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
