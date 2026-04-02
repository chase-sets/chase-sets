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
  seedMarketplaceDatabase,
} from "@chase-sets/marketplace-context";
import { identitySchemaSql } from "@chase-sets/identity";
import {
  createInventoryServices,
  inventorySchemaSql,
} from "@chase-sets/inventory";
import {
  createOrderingServices,
  orderingSchemaSql,
  seedOrderingDatabase,
} from "@chase-sets/ordering";
import {
  createPaymentsServices,
  createStripePaymentProcessorGateway,
  paymentsSchemaSql,
} from "@chase-sets/payments";
import type { Projector } from "@chase-sets/event-core/projector";
import { loadConfig } from "./config";

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
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Marketplace");
    await pool.query(
      [
        identitySchemaSql,
        inventorySchemaSql,
        discoverySchemaSql,
        marketplaceSchemaSql,
        orderingSchemaSql,
        fulfillmentSchemaSql,
        paymentsSchemaSql,
      ].join("\n\n"),
    );

    const eventCount = await countEvents(pool, "marketplace.");
    if (eventCount === 0) {
      await seedMarketplaceDatabase(pool);
    }

    const orderingEventCount = await countEvents(pool, "ordering.");
    if (orderingEventCount === 0) {
      await seedOrderingDatabase(pool);
    }

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
    const payments = createPaymentsServices(pool, {
      processorGateway: createStripePaymentProcessorGateway({
        secretKey: config.stripeSecretKey,
        publishableKey: config.stripePublishableKey,
        webhookSecret: config.stripeWebhookSecret,
        apiBaseUrl: config.stripeApiBaseUrl,
      }),
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
    await drainProjectors("Marketplace", [
      ...inventory.projectors,
      ...discovery.projectors,
      ...marketplace.projectors,
      ...payments.projectors,
      ...fulfillment.projectors,
      ...ordering.projectors,
    ]);
    console.log("Marketplace bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

async function countEvents(pool: ReturnType<typeof createPgPool>, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

void bootstrap().catch((error) => {
  console.error("Marketplace bootstrap failed.", error);
  process.exit(1);
});
