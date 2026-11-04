import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { BcApiModule } from "@chase-sets/bounded-context-module";
import {
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  bootstrapContextDatabase,
  createProjectionAwarePool,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
  type ReadConsistencyAuditRecord,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "@chase-sets/catalog";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProjectionWakeSchedulerRunners } from "@chase-sets/platform-runtime/projection-wake-scheduler";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import {
  createProjectionGroupRunnerLeaseName,
  createProjectionGroupWorkerRunner,
  createWorkerRunnerLoop,
  tryRunWithRenewedLease,
} from "@chase-sets/platform-runtime/worker";
import { module as inventoryModule } from "..";
import { buildInventoryApi, type InventoryApiEnv } from "../api";
import { createInventoryServices } from "../support/runtime-support/services";

// Refs #10672: test-only hosted reproduction; no inferred scheduler fix.
const contextNames = ["catalog", "ordering", "fulfillment", "inventory", "control"] as const;
const sellerAccountId = "acc_receipt_synthetic_seller";
const context: EventStoreContext = {
  tenantId: "tnt_receipt_synthetic",
  audit: { performedByUserId: "usr_receipt_synthetic_seller", forAccountId: sellerAccountId },
};
const sourceOnlyModule = (
  contextName: string,
): BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>> => ({
  contextName,
  routePrefix: `/api/${contextName}`,
  streamPrefix: `${contextName}.`,
  schemaSql: "",
  apiMounts: [],
  createServices: () => ({}),
  buildApis: () => [],
});
const orderingModule = sourceOnlyModule("ordering");
const fulfillmentModule = sourceOnlyModule("fulfillment");

describe("Inventory receipt idle-tail timeout", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is required for the Inventory receipt reproduction.");
    const urls = createMultiContextTestDatabaseUrls(baseUrl, contextNames, "inventory_receipt_idle_tail_timeout");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapPlatformControlPlane(pools.control);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
    await bootstrapContextDatabase(fulfillmentModule, pools.fulfillment);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(["default-config", "wake-before-wait"] as const)("%s", async (variant) => {
    const checkoutHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const event: { pull_request?: { head: { sha: string } } } = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const head = event.pull_request?.head.sha ?? checkoutHead;
    const trace: Array<{ kind: string; elapsedMs: number; event: unknown }> = [];
    const startedAt = performance.now();
    const record = (kind: string, event: unknown) => {
      trace.push({ kind, elapsedMs: performance.now() - startedAt, event });
    };
    const services = createInventoryServices(createProjectionAwarePool(pools.inventory));
    const mountedContexts: readonly MountedContextRuntimeEntry[] = [
      {
        contextName: "catalog",
        module: catalogModule,
        pool: pools.catalog,
        services: catalogModule.createServices(createProjectionAwarePool(pools.catalog), {}),
        projectionHandlerSets: [],
        mountRole: "source-only",
      },
      {
        contextName: "ordering",
        module: orderingModule,
        pool: pools.ordering,
        services: {},
        projectionHandlerSets: [],
        mountRole: "source-only",
      },
      {
        contextName: "fulfillment",
        module: fulfillmentModule,
        pool: pools.fulfillment,
        services: {},
        projectionHandlerSets: [],
        mountRole: "source-only",
      },
      {
        contextName: "inventory",
        module: inventoryModule,
        pool: pools.inventory,
        services,
        projectionHandlerSets: inventoryModule.projectionHandlerSets?.(services) ?? [],
      },
    ];
    const subscriptions = resolveModuleSubscriptions(mountedContexts);
    const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptions);
    await syncContextProjectionGroups({ mountedContexts, projectionGroups }, "inventory");
    const controlPlane = createPostgresPlatformControlPlane(pools.control);
    const workers = projectionGroups.map((group) => ({ group, runner: createProjectionGroupWorkerRunner(group) }));

    // A finite ordinary worker drain makes the written item visible, but does not
    // request idle settlement. Every pass still uses the production group lease.
    const ordinaryDrain = async () => {
      for (let pass = 0; pass < 20; pass += 1) {
        let processed = 0;
        for (const { group, runner } of workers) {
          const outcome = await tryRunWithRenewedLease(
            controlPlane,
            {
              leaseName: createProjectionGroupRunnerLeaseName(group),
              ownerId: "receipt-ordinary-worker",
              ttlMs: 30_000,
              renewIntervalMs: 10_000,
            },
            async (runContext) => runner.runOnce(runContext),
          );
          if (!outcome.acquired) throw new Error(`Fixture worker could not acquire ${runner.name}.`);
          processed += outcome.result.processed;
        }
        if (processed === 0) return;
      }
      throw new Error("Inventory receipt fixture did not drain its finite applicable work.");
    };
    const signals = createPostgresWorkSignalStore(pools.control, {
      ...(variant === "wake-before-wait" ? { readConsistencyGateway: {} } : {}),
      observer: {
        projectionWakeIntentEnqueued: (event) => {
          record("enqueued", event);
          wakeLoop.nudge();
        },
      },
    });
    const wakeLoop = createWorkerRunnerLoop({
      workerId: `receipt-wake-${variant}`,
      controlPlane,
      runners: createProjectionWakeSchedulerRunners({
        workerId: `receipt-wake-${variant}`,
        controlPlane,
        workSignalStore: signals,
        projectionGroups,
        observer: {
          wakeIntentClaimed: (event) => record("claimed", event),
          wakeIntentCompleted: (event) => record("completed", event),
          wakeIntentNotReady: (event) => record("not-ready", event),
          wakeIntentDeferred: (event) => record("deferred", event),
          wakeIntentUnknownTarget: (event) => record("unknown-target", event),
          wakeIntentRunFailed: (event) => record("run-failed", { ...event, error: String(event.error) }),
          wakeIntentClaimLost: (event) => record("claim-lost", event),
        },
      }),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      pollIntervalMs: 1_000,
      observer: { runnerFailed: (event) => record("worker-failed", { ...event, error: String(event.error) }) },
    });
    const mounts = inventoryModule.apiMounts.map((mount) => ({ ...mount, contextName: "inventory" }));
    const audits: ReadConsistencyAuditRecord[] = [];
    const app = new Hono<InventoryApiEnv>();
    app.use("/api/inventory/*", async (c, next) => {
      c.set("actor", {
        accountId: sellerAccountId,
        roleKey: "owner",
        permissions: ["inventory.view", "inventory.manage"],
      });
      c.set("context", context);
      await next();
    });
    attachWriteConsistencyMiddleware(app, mounts, projectionGroups, { enabled: false });
    attachReadConsistencyMiddleware(app, mounts, projectionGroups, {
      workSignalGateway: signals.readConsistencyGateway,
      recordReadConsistencyAudit: (audit) => audits.push(audit),
    });
    app.use("/api/inventory/*", async (c, next) => {
      await next();
      if (c.req.method === "POST" && c.res.status < 400) await ordinaryDrain();
    });
    app.route("/api/inventory", buildInventoryApi(services));
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Inventory-Mutation-Attempt": randomUUID() },
        body: JSON.stringify(body),
      });
    const durableCheckpoints = async () => ({
      checkpoints: (
        await pools.inventory.query(
          "SELECT checkpoint_key, last_global_position::text FROM event_subscription_checkpoints ORDER BY checkpoint_key",
        )
      ).rows,
      groups: await Promise.all(
        projectionGroups.map(async (group) => ({
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
          subscriptions: await Promise.all(group.subscriptionRunners.map((runner) => runner.refreshStatus())),
        })),
      ),
    });
    wakeLoop.start();
    try {
      const location = await post("/api/inventory/storage-locations", {
        name: "Synthetic receipt shelf",
        shipFromCode: "RECEIPT-SYNTHETIC",
        shipFromAddress: {
          name: "Synthetic seller",
          line1: "100 Test Lane",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
      });
      expect(location.status, await location.clone().text()).toBe(201);
      const locationBody = (await location.json()) as { id: string };
      const item = await post("/api/inventory/items", {
        catalogItemId: catalogSeedIds.items.charizardBaseSet,
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
          },
        ],
        storageLocationId: locationBody.id,
        totalQuantity: 1,
        acquisitionCostAmount: "1.00",
        acquisitionCostCurrencyCode: "USD",
      });
      expect(item.status, await item.clone().text()).toBe(201);
      const { id } = (await item.json()) as { id: string };
      const beforeSale = await durableCheckpoints();
      const sale = await post(`/api/inventory/items/${id}/offline-sales`, {
        quantity: 1,
        channel: "card-show",
        idempotencyKey: randomUUID(),
      });
      expect(sale.status, await sale.clone().text()).toBe(200);
      const commitReceipt = sale.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER);
      const sources = decodeCommitReceipt(commitReceipt);
      expect(sources).toContainEqual(
        expect.objectContaining({ sourceContextName: "inventory", eventIds: expect.any(Array) }),
      );
      const receipt = { observedAtMs: Date.now(), sources };
      const token = encodeFreshWriteReceipt(receipt);
      const read = async (path: string, receipted = true) => {
        const readStartedAt = performance.now();
        const response = await app.request(
          path,
          receipted ? { headers: { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: token } } : {},
        );
        const elapsedMs = performance.now() - readStartedAt;
        return { path, status: response.status, elapsedMs, body: await response.json() };
      };
      const [itemRead, listRead, control] = await Promise.all([
        read(`/api/inventory/items/${id}`),
        read("/api/inventory/items?limit=100&offset=0"),
        read(`/api/inventory/items/${id}`, false),
      ]);
      const afterReads = await durableCheckpoints();
      const intents = await pools.control.query(
        `SELECT source_context_name, target_context_name, projection_name, checkpoint_key,
                required_position::text, state, attempt_count, claim_owner_id,
                claim_fencing_token::text, last_error FROM platform_projection_wake_intents ORDER BY created_at, wake_intent_id`,
      );
      console.info(
        JSON.stringify({
          proof: "inventory-receipt-repro",
          head,
          checkoutHead,
          variant,
          config: {
            timeoutMs: 2_500,
            pollIntervalMs: 75,
            exactDependencyMode: "enabled",
            wakeBeforeWaitEnabled: variant === "wake-before-wait",
            inlineApplyEnabled: false,
          },
          scheduling:
            "finite ordinary leased drain before write response; real wake scheduler during reads; no sleeps or read retries",
          commitReceipt,
          receipt,
          requiredPositions: sources.map(({ sourceContextName, maxGlobalPosition }) => ({
            sourceContextName,
            maxGlobalPosition,
          })),
          sale: { status: sale.status, body: await sale.json() },
          itemRead,
          listRead,
          control,
          beforeSale,
          afterReads,
          audits,
          intents: intents.rows,
          trace,
        }),
      );
      expect(control.status).toBe(200);
      expect(control.body).toMatchObject({ total_quantity: 0, available_quantity: 0 });
      expect(itemRead.status, "receipt-bearing item must not falsely time out").toBe(200);
      expect(listRead.status, "receipt-bearing list must not falsely time out").toBe(200);
      expect(itemRead.elapsedMs).toBeLessThan(2_500);
      expect(listRead.elapsedMs).toBeLessThan(2_500);
      expect(itemRead.body).toMatchObject({ total_quantity: 0, available_quantity: 0 });
      expect(listRead.body).toMatchObject({
        items: [expect.objectContaining({ item_id: id, total_quantity: 0, available_quantity: 0 })],
      });
    } finally {
      await wakeLoop.stop();
    }
  });
});
