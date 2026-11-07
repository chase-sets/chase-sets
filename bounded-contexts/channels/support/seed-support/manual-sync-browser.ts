import { createPgPool } from "@chase-sets/event-core-postgres";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import type { Pool } from "pg";
import { module as channelsModule } from "../../index";
import {
  browserRecoveryContext,
  createBrowserRecoveryFixture,
  type BrowserRecoveryFixtureInput,
} from "../../features/manual-sync/tests/browser-recovery-fixture";

export { type BrowserRecoveryFixtureInput } from "../../features/manual-sync/tests/browser-recovery-fixture";

export function ownedRecoveryDatabaseUrls(channelsDatabaseUrl: unknown, catalogDatabaseUrl: unknown) {
  if (typeof channelsDatabaseUrl !== "string" || typeof catalogDatabaseUrl !== "string")
    throw new Error("owned-recovery-database-required");
  let channels: URL;
  let catalog: URL;
  try {
    channels = new URL(channelsDatabaseUrl);
    catalog = new URL(catalogDatabaseUrl);
  } catch {
    throw new Error("owned-recovery-database-not-local");
  }
  if (
    !["postgres:", "postgresql:"].includes(catalog.protocol) ||
    channels.protocol !== catalog.protocol ||
    !["localhost", "127.0.0.1", "[::1]"].includes(catalog.hostname) ||
    channels.host !== catalog.host ||
    channels.username !== catalog.username ||
    channels.password !== catalog.password ||
    !/^\/cs_[a-z0-9_]+_catalog$/.test(catalog.pathname) ||
    channels.pathname !== catalog.pathname.replace(/_catalog$/, "_channels")
  )
    throw new Error("owned-recovery-database-not-local");
  const marketplace = new URL(catalog);
  marketplace.pathname = catalog.pathname.replace(/_catalog$/, "_marketplace");
  const inventory = new URL(catalog);
  inventory.pathname = catalog.pathname.replace(/_catalog$/, "_inventory");
  return { channels, marketplace, inventory };
}

// Test-only additive seam authorized by https://github.com/chase-sets/chase-sets/issues/11115.
// Native sign-in, Listing publication and connection activation remain caller prerequisites.
export async function createManualSyncBrowserRecovery(
  input: BrowserRecoveryFixtureInput &
    Readonly<{
      channelsDatabaseUrl: unknown;
      catalogDatabaseUrl: unknown;
    }>,
) {
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") throw new Error("owned-recovery-web-server-required");
  const urls = ownedRecoveryDatabaseUrls(input.channelsDatabaseUrl, input.catalogDatabaseUrl);
  const pools = {
    channels: createPgPool(urls.channels.toString(), { max: 2 }),
    marketplace: createPgPool(urls.marketplace.toString(), { max: 2 }),
    inventory: createPgPool(urls.inventory.toString(), { max: 2 }),
  };
  try {
    const marketplace = marketplaceModule.createServices(pools.marketplace, {});
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, browserRecoveryContext),
    });
    return await createBrowserRecoveryFixture(
      pools.channels,
      services,
      {
        pool: pools.marketplace,
        listings: marketplace.listings,
      },
      input,
    );
  } finally {
    await Promise.all(Object.values(pools).map((pool) => (pool as unknown as Pool).end()));
  }
}
