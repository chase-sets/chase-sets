import type { BcSeedAggregateStateReport, BcSeedOptions } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import { module as checkoutModule } from "@chase-sets/checkout";
import { checkoutSeedIds } from "@chase-sets/checkout/server";
import { module as inventoryModule } from "@chase-sets/inventory";
import { inventorySeedIds } from "@chase-sets/inventory/server";
import { identitySeedIds } from "@chase-sets/identity/server";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { describe, expect, it } from "vitest";
import { createPlatformApiHost as createPlatformApiHostRuntime } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

const TEST_PROVIDER_MODE_OBSERVATION = {
  mode: "unconfigured",
  paymentProcessorKind: "fake",
  moneyMovementKind: "fake",
  deploymentEnvironment: "test",
} as const;

function createPlatformApiHost(options: Parameters<typeof createPlatformApiHostRuntime>[0]) {
  return createPlatformApiHostRuntime({
    ...options,
    hostPorts: {
      ...options.hostPorts,
      providerModeObservation: TEST_PROVIDER_MODE_OBSERVATION,
    },
  });
}

/**
 * The confirmed #4906 failure and its resume/fail-closed controls, scoped to
 * the smallest mount set that can seed them: `catalog` (the projected catalog
 * items both seeds read), `inventory` (the context whose
 * `Storage location has already been created` failure blocked the 2026-07-25
 * probe), and `checkout` (a set-shaped seed whose two cart lines must resume
 * per row).
 */
const activeContextNames = ["catalog", "inventory", "checkout"] as const satisfies readonly PlatformApiContextName[];
const scopedRegistry = apiContextRegistry.filter((context) =>
  (activeContextNames as readonly string[]).includes(context.contextName),
);
const seedOptions: BcSeedOptions = {
  enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
  environmentName: "test",
};

const northShelfStream = `inventory.storage-location-${inventorySeedIds.storageLocations.northShelf}`;
const vaultAnnexStream = `inventory.storage-location-${inventorySeedIds.storageLocations.vaultAnnex}`;
const archivedOverflowStream = `inventory.storage-location-${inventorySeedIds.storageLocations.archivedOverflow}`;
const checkoutCartStream = `checkout.cart-${identitySeedIds.collector.accountId}`;
const checkoutSessionStream = `checkout.session-${checkoutSeedIds.sessions.startedCart}`;

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness(
  "platform_api_inventory_seed_resume",
  (state) => {
    pools = state.pools;
  },
  { activeContextNames },
);

function createScopedHost() {
  const runtime = createPlatformApiHost({
    runtimeProfile: "public",
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
  const included = (contextName: string) => (activeContextNames as readonly string[]).includes(contextName);

  return {
    ...runtime,
    mountedContexts: runtime.mountedContexts.filter((context) => included(context.contextName)),
    mountedModules: runtime.mountedModules.filter((entry) => included(entry.module.contextName)),
    // Groups fed by a context outside this partition would read an event-store
    // head from a database the scoped harness never provisioned.
    projectionGroups: runtime.projectionGroups.filter(
      (group) =>
        included(group.targetContextName) && group.sourceContextNames.every((sourceName) => included(sourceName)),
    ),
    subscriptionRunners: runtime.subscriptionRunners.filter(
      (runner) => included(runner.targetContextName) && included(runner.sourceContextName),
    ),
  };
}

async function prepareHost() {
  await resetMultiContextTestSchemas({
    catalog: pools.catalog,
    inventory: pools.inventory,
    checkout: pools.checkout,
  });
  const runtime = createScopedHost();
  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }
  return runtime;
}

async function ordinaryBoot(runtime: Awaited<ReturnType<typeof prepareHost>>): Promise<void> {
  await seedApiHostIfEmpty(scopedRegistry, "platform-api", runtime, seedOptions);
}

async function streamEventCount(contextName: "inventory" | "checkout" | "catalog", streamId: string): Promise<number> {
  const result = await pools[contextName].query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
    [streamId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function contextEventCount(contextName: "inventory" | "checkout" | "catalog"): Promise<number> {
  const result = await pools[contextName].query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function inventorySeedState(): Promise<readonly BcSeedAggregateStateReport[]> {
  if (!inventoryModule.inspectSeedState) {
    throw new Error("Inventory module declares no stream-sourced seed state.");
  }
  return inventoryModule.inspectSeedState(pools.inventory);
}

async function checkoutSeedState(): Promise<readonly BcSeedAggregateStateReport[]> {
  if (!checkoutModule.inspectSeedState) {
    throw new Error("Checkout module declares no stream-sourced seed state.");
  }
  return checkoutModule.inspectSeedState(pools.checkout);
}

function expectAllActive(reports: readonly BcSeedAggregateStateReport[], label: string): void {
  const incomplete = reports.filter((report) => report.kind !== "active");
  expect(incomplete, `${label}: ${JSON.stringify(incomplete)}`).toEqual([]);
  expect(reports.length, `${label} reports no seed aggregates`).toBeGreaterThan(0);
}

function inventoryStorageLocationCommandHandler(runtime: Awaited<ReturnType<typeof prepareHost>>) {
  const inventory = runtime.mountedContexts.find((context) => context.contextName === "inventory");
  const services = inventory?.services as {
    storageLocations: {
      commandHandler: (input: { streamId: string; command: unknown; context: unknown }) => Promise<unknown>;
    };
  };
  return services.storageLocations.commandHandler;
}

const seedCommandContext = {
  tenantId: "tnt_seed_development",
  audit: {
    performedByUserId: identitySeedIds.demo.userId,
    forAccountId: identitySeedIds.demo.accountId,
  },
};

describe("inventory and checkout seed resume from authoritative streams", () => {
  it("reseeds inventory after its truncated UNLOGGED projections without duplicate creation", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);

    const beforeTruncation = await contextEventCount("inventory");
    expect(beforeTruncation).toBeGreaterThan(0);

    // Simulate PostgreSQL crash recovery of UNLOGGED projections: the read
    // models are empty, every `inventory.*` stream survives.
    await pools.inventory.query("TRUNCATE TABLE inventory_holds, inventory_items, inventory_storage_locations CASCADE");
    const remaining = await pools.inventory.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM inventory_storage_locations",
    );
    expect(Number(remaining.rows[0]?.count ?? 0)).toBe(0);
    expect(await contextEventCount("inventory")).toBe(beforeTruncation);

    // At parent commit e81b6b43 this reseed throws
    // `InventoryDomainError: Storage location has already been created.`
    await ordinaryBoot(runtime);

    expect(await contextEventCount("inventory")).toBe(beforeTruncation);
    expectAllActive(await inventorySeedState(), "inventory after resume");
  });

  it("appends events only on the first of three same-boot inventory and checkout seed invocations", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);
    await pools.inventory.query("TRUNCATE TABLE inventory_holds, inventory_items, inventory_storage_locations CASCADE");
    await pools.checkout.query("TRUNCATE TABLE checkout_cart_line_pages, checkout_session_pages CASCADE");

    const before = {
      inventory: await contextEventCount("inventory"),
      checkout: await contextEventCount("checkout"),
    };

    // Mirrors platform-runtime/api.ts:468, :475 and :494 inside one boot.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      for (const context of runtime.mountedContexts) {
        if (!context.module.seed) {
          continue;
        }
        await context.module.seed(context.pool, context.services, seedOptions);
      }
      expect(
        { inventory: await contextEventCount("inventory"), checkout: await contextEventCount("checkout") },
        `invocation ${invocation}`,
      ).toEqual(before);
    }
  });

  it("resumes inventory from a committed-but-incomplete storage location", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);

    // Retain only the first storage-location stream, drop everything the seed
    // authored after it, and empty the projections: a seed that died mid-stage.
    await pools.inventory.query(
      "DELETE FROM event_store_events WHERE stream_id LIKE 'inventory.%' AND stream_id <> $1",
      [northShelfStream],
    );
    await pools.inventory.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id LIKE 'inventory.%'");
    await pools.inventory.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id LIKE 'inventory.%' AND stream_id <> $1",
      [northShelfStream],
    );
    await pools.inventory.query("TRUNCATE TABLE inventory_holds, inventory_items, inventory_storage_locations CASCADE");

    const retainedNorthShelf = await streamEventCount("inventory", northShelfStream);
    expect(retainedNorthShelf).toBeGreaterThan(0);
    expect(await streamEventCount("inventory", vaultAnnexStream)).toBe(0);

    await ordinaryBoot(runtime);
    // The retained aggregate is resumed, not re-authored.
    expect(await streamEventCount("inventory", northShelfStream)).toBe(retainedNorthShelf);
    expect(await streamEventCount("inventory", vaultAnnexStream)).toBeGreaterThan(0);
    expectAllActive(await inventorySeedState(), "inventory after mid-command resume");

    const afterBootOne = await contextEventCount("inventory");
    await ordinaryBoot(runtime);
    expect(await contextEventCount("inventory")).toBe(afterBootOne);
    expectAllActive(await inventorySeedState(), "inventory after second ordinary boot");
  });

  it("resumes an archived storage location committed before its archive step", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);

    // Roll the archived-overflow aggregate back to its created event only: a
    // committed-but-draft aggregate must resume, not be re-created and not be
    // mistaken for finished.
    await pools.inventory.query(
      `DELETE FROM event_store_events
       WHERE stream_id = $1 AND event_type <> 'inventory.storage-location.created'`,
      [archivedOverflowStream],
    );
    await pools.inventory.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [
      archivedOverflowStream,
    ]);
    await pools.inventory.query(
      "UPDATE event_store_streams SET current_version = 1, updated_at = now() WHERE stream_id = $1",
      [archivedOverflowStream],
    );
    await pools.inventory.query("TRUNCATE TABLE inventory_holds, inventory_items, inventory_storage_locations CASCADE");
    expect(await streamEventCount("inventory", archivedOverflowStream)).toBe(1);

    const draft = (await inventorySeedState()).find((report) => report.streamId === archivedOverflowStream);
    expect(draft?.kind).toBe("draft");

    await ordinaryBoot(runtime);
    expect(await streamEventCount("inventory", archivedOverflowStream)).toBe(3);
    expectAllActive(await inventorySeedState(), "inventory after draft repair");

    const afterBootOne = await contextEventCount("inventory");
    await ordinaryBoot(runtime);
    expect(await contextEventCount("inventory")).toBe(afterBootOne);
  });

  it("resumes a checkout cart holding only one of its two seeded lines", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);
    expectAllActive(await checkoutSeedState(), "checkout after boot one");

    // Drop the second cart line and the session, keeping the first line: the
    // set-shaped decision must resume per row, not all-or-nothing.
    await pools.checkout.query(
      `DELETE FROM event_store_events
       WHERE stream_id = $1
         AND payload->>'lineId' = $2`,
      [checkoutCartStream, checkoutSeedIds.cartLines.demoPikachuJungleExcellent],
    );
    await pools.checkout.query("DELETE FROM event_store_events WHERE stream_id = $1", [checkoutSessionStream]);
    await pools.checkout.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = ANY($1::text[])", [
      [checkoutCartStream, checkoutSessionStream],
    ]);
    await pools.checkout.query(
      "UPDATE event_store_streams SET current_version = 1, updated_at = now() WHERE stream_id = $1",
      [checkoutCartStream],
    );
    await pools.checkout.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [checkoutSessionStream],
    );
    await pools.checkout.query("TRUNCATE TABLE checkout_cart_line_pages, checkout_session_pages CASCADE");

    const partial = await checkoutSeedState();
    expect(partial.filter((report) => report.kind === "active").length).toBe(1);
    expect(partial.filter((report) => report.kind === "absent").length).toBe(2);
    expect(await streamEventCount("checkout", checkoutCartStream)).toBe(1);

    await ordinaryBoot(runtime);
    expect(await streamEventCount("checkout", checkoutCartStream)).toBe(2);
    expectAllActive(await checkoutSeedState(), "checkout after per-row resume");

    const afterBootOne = await contextEventCount("checkout");
    await ordinaryBoot(runtime);
    expect(await contextEventCount("checkout")).toBe(afterBootOne);
    expectAllActive(await checkoutSeedState(), "checkout after second ordinary boot");
  });

  it("fails closed on conflicting retained inventory identity metadata", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);

    await pools.inventory.query(
      `UPDATE event_store_events
       SET payload = jsonb_set(payload, '{shipFromCode}', '"CONFLICTING-CODE"')
       WHERE stream_id = $1 AND event_type = 'inventory.storage-location.created'`,
      [northShelfStream],
    );
    await pools.inventory.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [northShelfStream]);
    await pools.inventory.query("TRUNCATE TABLE inventory_holds, inventory_items, inventory_storage_locations CASCADE");

    const message =
      "Inventory seed bootstrap Storage Location 'CHI-WH-1' expected id " +
      `'${inventorySeedIds.storageLocations.northShelf}' and key 'CHI-WH-1', but found id ` +
      `'${inventorySeedIds.storageLocations.northShelf}' and key 'CONFLICTING-CODE'. Stream '${northShelfStream}'.`;
    await expect(ordinaryBoot(runtime)).rejects.toThrow(message);
    // Fail-closed on every boot, not only the first.
    await expect(ordinaryBoot(runtime)).rejects.toThrow(message);
    await expect(inventorySeedState()).rejects.toThrow(message);
  });

  it("fails closed on a terminal retained inventory aggregate", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);

    await inventoryStorageLocationCommandHandler(runtime)({
      streamId: northShelfStream,
      command: { type: "ArchiveStorageLocation" },
      context: seedCommandContext,
    });

    const message =
      "Inventory seed bootstrap Storage Location 'CHI-WH-1' expected status 'active', " +
      `but found terminal status 'archived'. Stream '${northShelfStream}'.`;
    await expect(ordinaryBoot(runtime)).rejects.toThrow(message);
    await expect(ordinaryBoot(runtime)).rejects.toThrow(message);
    await expect(inventorySeedState()).rejects.toThrow(message);
  });

  it("keeps ordinary duplicate-create rejection unchanged for non-seed commands", async () => {
    const runtime = await prepareHost();
    await ordinaryBoot(runtime);
    const before = await streamEventCount("inventory", northShelfStream);

    await expect(
      inventoryStorageLocationCommandHandler(runtime)({
        streamId: northShelfStream,
        command: {
          type: "CreateStorageLocation",
          storageLocationId: inventorySeedIds.storageLocations.northShelf,
          accountId: identitySeedIds.demo.accountId,
          name: "Duplicate authoring control",
          shipFromCode: "CHI-WH-1",
          shipFromAddress: {
            name: "Chase Sets Shipping",
            line1: "221 N LaSalle St",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
        },
        context: seedCommandContext,
      }),
    ).rejects.toThrow("Storage location has already been created.");

    expect(await streamEventCount("inventory", northShelfStream)).toBe(before);
  });
});
