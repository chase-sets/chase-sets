import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { Readable } from "node:stream";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import type { Pool } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { module as channelsModule } from "../../index";
import {
  browserRecoveryContext,
  assertBrowserRecoveryFixtureInput,
  createBrowserRecoveryFixture,
  type BrowserRecoveryFixtureInput,
} from "../../features/manual-sync/tests/browser-recovery-fixture";

export { type BrowserRecoveryFixtureInput } from "../../features/manual-sync/tests/browser-recovery-fixture";

export function ownedRecoveryDatabaseUrls(channelsDatabaseUrl: unknown, catalogDatabaseUrl: unknown) {
  if (
    typeof channelsDatabaseUrl !== "string" ||
    typeof catalogDatabaseUrl !== "string" ||
    Buffer.byteLength(channelsDatabaseUrl) > 2048 ||
    Buffer.byteLength(catalogDatabaseUrl) > 2048
  )
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
    channels.search !== "" ||
    channels.hash !== "" ||
    catalog.search !== "" ||
    catalog.hash !== "" ||
    channels.username !== channels.pathname.slice(1) ||
    channels.password !== channels.pathname.slice(1) ||
    catalog.username !== catalog.pathname.slice(1) ||
    catalog.password !== catalog.pathname.slice(1) ||
    !/^\/cs_[a-z0-9_]+_catalog$/.test(catalog.pathname) ||
    channels.pathname !== catalog.pathname.replace(/_catalog$/, "_channels")
  )
    throw new Error("owned-recovery-database-not-local");
  const marketplace = new URL(catalog);
  marketplace.pathname = catalog.pathname.replace(/_catalog$/, "_marketplace");
  marketplace.username = marketplace.password = marketplace.pathname.slice(1);
  const inventory = new URL(catalog);
  inventory.pathname = catalog.pathname.replace(/_catalog$/, "_inventory");
  inventory.username = inventory.password = inventory.pathname.slice(1);
  return { channels, marketplace, inventory };
}

// Test-only finite composition: https://github.com/chase-sets/chase-sets/issues/11137.
// Native sign-in, Listing publication and connection activation remain caller prerequisites.
export async function createManualSyncBrowserRecovery(
  input: BrowserRecoveryFixtureInput,
  databases: Readonly<{ channels: unknown; catalog: unknown }>,
) {
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") throw new Error("owned-recovery-web-server-required");
  assertBrowserRecoveryFixtureInput(input);
  const urls = ownedRecoveryDatabaseUrls(databases.channels, databases.catalog);
  const ownedPools: Pool[] = [];
  const acquire = (url: URL) => {
    const pool = createPgPool(url.toString(), {
      max: 2,
      connectionTimeoutMillis: 5000,
      idleInTransactionSessionTimeoutMillis: 5000,
    });
    ownedPools.push(pool as unknown as Pool);
    return pool;
  };
  try {
    const pools = {
      channels: acquire(urls.channels),
      marketplace: acquire(urls.marketplace),
      inventory: acquire(urls.inventory),
    };
    const marketplace = marketplaceModule.createServices(pools.marketplace, {});
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, browserRecoveryContext),
    });
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.projectors);
    const fixture = await createBrowserRecoveryFixture(
      pools.channels,
      services,
      {
        pool: pools.marketplace,
        listings: marketplace.listings,
      },
      input,
    );
    const events = await readCompleteStream(
      createPostgresEventStore({
        pool: pools.channels,
        wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "channels" }),
      }),
      {
        streamId: `channels.tcgplayer-sync-run-${fixture.runId}`,
        maxEvents: 2,
      },
    );
    const initial = events[0]?.payload.run as Record<string, unknown> | undefined;
    if (
      events.length !== 1 ||
      events[0]?.eventType !== "channels.tcgplayer-sync-run.composed" ||
      !initial ||
      typeof initial !== "object" ||
      initial.runId !== fixture.runId ||
      initial.connectionId !== input.connectionId ||
      initial.revision !== 0 ||
      initial.state !== "composed"
    )
      throw new Error("owned-recovery-initial-state-required");
    await drainLocalProjectionHandlerSets("channels", pools.channels, services.projectors);
    const panel = await services.manualSync.readPanel({
      accountId: browserRecoveryContext.audit.forAccountId!,
      connectionId: input.connectionId,
    });
    if (
      !panel ||
      !panel.run ||
      panel.run.runId !== fixture.runId ||
      panel.run.revision !== 0 ||
      panel.run.state !== "composed" ||
      panel.attentionReason !== "recovery"
    )
      throw new Error("owned-recovery-initial-state-required");
    return { version: 1 as const, ownershipId: input.ownershipId, ...fixture, runRevision: 0 as const };
  } finally {
    const closed = await Promise.allSettled(ownedPools.map((pool) => Promise.resolve().then(() => pool.end())));
    if (closed.some((result) => result.status === "rejected")) throw new Error("owned-recovery-close-failed");
  }
}

export function parseOwnedRecoveryRequest(bytes: Uint8Array) {
  if (bytes.byteLength > 8192) throw new Error("owned-recovery-protocol-invalid");
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("owned-recovery-protocol-invalid");
  }
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).sort().join(",") !== "databases,fixture,version"
  )
    throw new Error("owned-recovery-protocol-invalid");
  const value = request as Record<string, unknown>;
  if (value.version !== 1) throw new Error("owned-recovery-protocol-invalid");
  assertBrowserRecoveryFixtureInput(value.fixture);
  const databases = value.databases;
  if (
    !databases ||
    typeof databases !== "object" ||
    Array.isArray(databases) ||
    Object.keys(databases).sort().join(",") !== "catalog,channels" ||
    !("channels" in databases) ||
    !("catalog" in databases)
  )
    throw new Error("owned-recovery-protocol-invalid");
  const urls = { channels: databases.channels, catalog: databases.catalog };
  ownedRecoveryDatabaseUrls(urls.channels, urls.catalog);
  return { fixture: value.fixture, databases: urls };
}

export async function runOwnedRecoveryStdin(
  input: Readable,
  output: NodeJS.WritableStream,
  errors: NodeJS.WritableStream,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  let code = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new Error("owned-recovery-protocol-invalid");
      chunks.push(bytes);
    }
    const request = parseOwnedRecoveryRequest(Buffer.concat(chunks));
    const receipt = await createManualSyncBrowserRecovery(request.fixture, request.databases);
    const serialized = JSON.stringify(receipt);
    if (Buffer.byteLength(serialized) > 2048) throw new Error("owned-recovery-protocol-invalid");
    await new Promise<void>((resolve, reject) =>
      output.write(serialized, (error) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    code = 1;
    const reason = error instanceof Error ? error.message : "";
    const knownReasons = [
      "owned-recovery-input-required",
      "owned-recovery-database-required",
      "owned-recovery-database-not-local",
      "owned-recovery-web-server-required",
      "owned-recovery-listing-required",
      "owned-recovery-listing-collision",
      "owned-recovery-connection-required",
      "owned-recovery-run-collision",
      "owned-recovery-member-required",
      "owned-recovery-initial-state-required",
      "owned-recovery-close-failed",
    ];
    const diagnostic = knownReasons.includes(reason)
      ? reason
      : reason === "owned-recovery-protocol-invalid"
        ? ""
        : error instanceof TypeError
          ? "type-error"
          : "unexpected-error";
    await new Promise<void>((resolve, reject) =>
      errors.write(`OWNED_RECOVERY_FAILED${diagnostic ? ` ${diagnostic}` : ""}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => {
      if (input.closed) resolve();
      else {
        input.once("close", resolve);
        input.destroy();
      }
    });
  }
  return code;
}

if (
  process.argv.length === 3 &&
  process.argv[2] === "--owned-recovery-stdin" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runOwnedRecoveryStdin(process.stdin, process.stdout, process.stderr);
}
