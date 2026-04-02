import { catalogAuthoringSchemaSql } from "@chase-sets/catalog-authoring";
import {
  createDiscoveryServices,
  discoverySchemaSql,
} from "@chase-sets/discovery";
import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  createFulfillmentServices,
  fulfillmentSchemaSql,
} from "@chase-sets/fulfillment";
import {
  createMarketplaceServices,
  marketplaceSchemaSql,
} from "@chase-sets/marketplace-context";
import { identitySchemaSql } from "@chase-sets/identity";
import {
  createInventoryServices,
  inventorySchemaSql,
} from "@chase-sets/inventory";
import {
  createOrderingServices,
  orderingSchemaSql,
} from "@chase-sets/ordering";
import {
  createPaymentsServices,
  createFakePaymentProcessorGateway,
  paymentsSchemaSql,
} from "@chase-sets/payments";
import {
  createReputationServices,
  reputationSchemaSql,
} from "@chase-sets/reputation";
import {
  createSettlementServices,
  settlementSchemaSql,
} from "@chase-sets/settlement";
import type { Projector } from "@chase-sets/event-core/projector";
import { loadBootstrapConfig } from "./config";
import { seedMarketplaceStack } from "./seed-stack";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(
  pool: ReturnType<typeof createPgPool>,
  description: string,
) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `${description} database did not become ready after ${MAX_RETRIES} attempts.`,
          { cause: error },
        );
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function drainProjectors(label: string, projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);

  console.log(`${label} projections are up to date.`);
}

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Marketplace");
    await pool.query(
      [
        catalogAuthoringSchemaSql,
        identitySchemaSql,
        inventorySchemaSql,
        discoverySchemaSql,
        marketplaceSchemaSql,
        orderingSchemaSql,
        fulfillmentSchemaSql,
        paymentsSchemaSql,
        reputationSchemaSql,
        settlementSchemaSql,
      ].join("\n\n"),
    );
    await seedMarketplaceStack(pool);

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
    const fulfillment = createFulfillmentServices(pool);
    const reputation = createReputationServices(pool);
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
    const settlement = createSettlementServices(pool);
    await drainProjectors("Marketplace", [
      ...inventory.projectors,
      ...discovery.projectors,
      ...marketplace.projectors,
      ...payments.projectors,
      ...fulfillment.projectors,
      ...ordering.projectors,
      ...reputation.projectors,
      ...settlement.projectors,
    ]);
    console.log("Marketplace bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Marketplace bootstrap failed.", error);
  process.exit(1);
});
