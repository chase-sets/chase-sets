import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  attachReadConsistencyMiddleware,
  bootstrapContextDatabase,
  mountApiRouters,
  resolveModuleApiMounts,
  syncContextProjectionGroups,
  type ReadConsistencyAuditRecord,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
import { module as catalogModule } from "../index";
import { type CatalogAuthoringEnv } from "../support/authoring-support/api";
import type { CatalogServices } from "../support/authoring-support";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog", "control"] as const;
const context: EventStoreContext = {
  tenantId: "tnt_read_freshness" as never,
  audit: { performedByUserId: "usr_read_freshness" as never, forAccountId: "acc_read_freshness" as never },
};

describeDb("Catalog item read freshness DB proof", () => {
  let pool: PgTransactionalPool;
  let controlPool: PgTransactionalPool;
  let services: CatalogServices;
  let projectionGroups: ReturnType<typeof createMountedContextTestRuntime>["projectionGroups"];

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "catalog_item_read_freshness");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    const pools = createMultiContextTestPools(urls);
    pool = pools.catalog;
    controlPool = pools.control;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool, control: controlPool });
    await bootstrapPlatformControlPlane(controlPool);
    await bootstrapContextDatabase(catalogModule, pool);
    const runtime = createMountedContextTestRuntime([
      { contextName: "catalog", module: catalogModule, pool, ports: {} },
    ]);
    services = runtime.services.catalog as CatalogServices;
    projectionGroups = runtime.projectionGroups;
    await syncContextProjectionGroups(runtime, "catalog");
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool, control: controlPool });
  });

  it("catalog image URL read follows committed application", async () => {
    const itemId = "cat_read_freshness";
    const streamId = `catalog.item-${itemId}`;
    const eventStore = createPostgresEventStore({ pool });
    const controlPlane = createPostgresPlatformControlPlane(controlPool);
    const ordinaryDrain = async () => {
      let processed: number;
      do {
        processed = 0;
        for (const group of projectionGroups) {
          const outcome = await tryRunWithRenewedLease(
            controlPlane,
            {
              leaseName: createProjectionGroupRunnerLeaseName(group),
              ownerId: "catalog-fixture-worker",
              ttlMs: 30_000,
              renewIntervalMs: 10_000,
            },
            async (runContext) => createProjectionGroupWorkerRunner(group).runOnce(runContext),
          );
          if (!outcome.acquired) throw new Error(`Fixture could not acquire ${group.projectionName}.`);
          processed += outcome.result.processed;
        }
      } while (processed > 0);
    };

    await services.items.commandHandler({
      streamId,
      command: {
        type: "CreateCatalogItem",
        itemId,
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Fresh image" } },
        subtitle: null,
        description: { defaultLocale: "en", values: { en: "Fresh image description" } },
      },
      context,
    });
    await ordinaryDrain();

    await services.items.commandHandler({
      streamId,
      expectedVersion: 1,
      command: { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/old-image.webp"] },
      context,
    });
    await ordinaryDrain();

    const adminName = "catalog-admin-catalog-item-projection";
    const unrelatedName = "catalog-scope-registry-projection";
    const requiredNames = [
      adminName,
      "catalog-item-projection",
      "catalog-field-projection",
      "catalog-display-template-projection",
      "catalog-alias-projection",
    ];
    const heldLeases = await Promise.all(
      [adminName, unrelatedName].map(async (name) => {
        const group = projectionGroups.find((candidate) => candidate.projectionName === name);
        expect(group).toBeDefined();
        const lease = await controlPlane.acquireLease({
          leaseName: createProjectionGroupRunnerLeaseName(group!),
          ownerId: "catalog-foreign-worker",
          ttlMs: 30_000,
        });
        if (!lease) throw new Error(`Foreign worker could not acquire ${name}.`);
        return lease;
      }),
    );
    const completed = new Map<string, () => void>();
    const completions = new Map(
      requiredNames.map((name) => [name, new Promise<void>((resolve) => completed.set(name, resolve))]),
    );
    let adminDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      adminDeferred = resolve;
    });
    const trace: Array<{ kind: string; event: unknown }> = [];
    const failures: unknown[] = [];
    const signals = createPostgresWorkSignalStore(controlPool, {
      readConsistencyGateway: {},
      observer: { projectionWakeIntentEnqueued: () => wakeLoop.nudge() },
    });
    const wakeLoop = createWorkerRunnerLoop({
      workerId: "catalog-receipt-wake",
      controlPlane,
      runners: createProjectionWakeSchedulerRunners({
        workerId: "catalog-receipt-wake",
        controlPlane,
        workSignalStore: signals,
        projectionGroups,
        observer: {
          wakeIntentClaimed: (event) => trace.push({ kind: "claimed", event }),
          wakeIntentCompleted: (event) => {
            trace.push({ kind: "completed", event });
            if (!event.requeued) completed.get(event.projectionName)?.();
          },
          wakeIntentDeferred: (event) => {
            trace.push({ kind: "deferred", event });
            if (event.projectionName === adminName) adminDeferred();
          },
          wakeIntentRunFailed: (event) => failures.push({ ...event, error: String(event.error) }),
          wakeIntentClaimLost: (event) => failures.push(event),
          wakeIntentNotReady: (event) => failures.push(event),
          checkpointReadinessRecordFailed: (event) => failures.push({ ...event, error: String(event.error) }),
        },
      }),
      maxConcurrentRunners: 2,
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      pollIntervalMs: 1_000,
      observer: { runnerFailed: (event) => failures.push({ ...event, error: String(event.error) }) },
    });
    wakeLoop.start();
    try {
      await services.items.commandHandler({
        streamId,
        expectedVersion: 2,
        command: { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/fresh-image.webp"] },
        context,
      });
      const stored = await eventStore.readStream({ streamId, fromVersion: 3, limit: 1 });
      const committedEvent = stored[0];
      expect(committedEvent).toBeDefined();

      const mounts = resolveModuleApiMounts(catalogModule, services);
      const audits: ReadConsistencyAuditRecord[] = [];
      const app = new Hono<CatalogAuthoringEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { permissions: ["catalog.view", "catalog.manage"] });
        c.set("context", context);
        await next();
      });
      attachReadConsistencyMiddleware(app, mounts, projectionGroups, {
        workSignalGateway: signals.readConsistencyGateway,
        recordReadConsistencyAudit: (audit) => audits.push(audit),
      });
      mountApiRouters(app, mounts);
      const receipt = encodeFreshWriteReceipt({
        observedAtMs: Date.now(),
        sources: [
          {
            sourceContextName: "catalog",
            maxGlobalPosition: String(committedEvent!.globalPosition),
            eventIds: [committedEvent!.eventId],
          },
        ],
      });
      const read = () =>
        app.request(`http://catalog.test/api/catalog/items/${itemId}`, {
          headers: { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: receipt },
        });

      const checkpoints = async () =>
        (
          await pool.query<{ checkpoint_key: string; last_global_position: string }>(
            "SELECT checkpoint_key, last_global_position::text FROM event_subscription_checkpoints ORDER BY checkpoint_key",
          )
        ).rows;
      const beforeReads = await checkpoints();
      const blocked = await read();
      const blockedBody = await blocked.json();
      const blockedAudit = audits.at(-1);
      const oldDetail = await services.items.getCatalogItemDetail(itemId);
      const blockedCheckpoints = await checkpoints();

      await controlPlane.releaseLease(heldLeases[0]!);
      const fresh = await read();
      const freshBody = await fresh.json();
      const freshAudit = audits.at(-1);
      console.info(
        JSON.stringify({
          proof: "catalog-receipt-leased-wakes",
          receipt,
          beforeReads,
          blocked: {
            status: blocked.status,
            body: blockedBody,
            audit: blockedAudit,
            oldDetail,
            checkpoints: blockedCheckpoints,
          },
          fresh: { status: fresh.status, body: freshBody, audit: freshAudit },
          trace,
        }),
      );
      expect(fresh.status, JSON.stringify({ body: freshBody, audit: freshAudit })).toBe(200);
      expect(blocked.status, JSON.stringify({ body: blockedBody, audit: blockedAudit })).toBe(503);
      expect(blockedBody).toMatchObject({ error: { code: "projection_freshness_timeout" } });
      expect(blockedAudit).toMatchObject({
        outcome: "timeout",
        waitMode: "exact-dependency",
        pending: [expect.objectContaining({ projectionName: adminName })],
      });
      expect(oldDetail).toMatchObject({ image_urls: ["https://assets.example/old-image.webp"] });
      expect(freshBody).toMatchObject({ image_urls: ["https://assets.example/fresh-image.webp"] });
      expect(freshAudit).toMatchObject({ outcome: "fresh", waitMode: "exact-dependency" });
      await deferred;
      await Promise.all(completions.values());
      const afterReads = await checkpoints();
      for (const name of requiredNames) {
        const group = projectionGroups.find((candidate) => candidate.projectionName === name)!;
        for (const runner of group.subscriptionRunners) {
          const checkpoint = afterReads.find((row) => row.checkpoint_key === runner.checkpointKey);
          expect(checkpoint, name).toBeDefined();
          expect(BigInt(checkpoint!.last_global_position), name).toBeGreaterThanOrEqual(
            BigInt(committedEvent!.globalPosition),
          );
          if (name !== adminName) {
            const blockedCheckpoint = blockedCheckpoints.find((row) => row.checkpoint_key === runner.checkpointKey);
            expect(BigInt(blockedCheckpoint!.last_global_position), name).toBeGreaterThanOrEqual(
              BigInt(committedEvent!.globalPosition),
            );
          }
        }
      }
      const unrelated = projectionGroups.find((group) => group.projectionName === unrelatedName)!;
      for (const runner of unrelated.subscriptionRunners) {
        const checkpoint = afterReads.find((row) => row.checkpoint_key === runner.checkpointKey);
        expect(checkpoint, unrelatedName).toBeDefined();
        expect(BigInt(checkpoint!.last_global_position)).toBeLessThan(BigInt(committedEvent!.globalPosition));
      }
      const nextRead = await read();
      expect(nextRead.status).toBe(200);
      expect(await nextRead.json()).toMatchObject({ image_urls: ["https://assets.example/fresh-image.webp"] });
      expect(audits.at(-1)).toMatchObject({ outcome: "fresh", wakeRequestCount: 0 });
      const afterNextRead = await checkpoints();
      expect(afterNextRead).toEqual(afterReads);
      expect(failures).toEqual([]);
      const intents = (
        await controlPool.query<{ projection_name: string; state: string; last_error: unknown }>(
          "SELECT projection_name, state, last_error FROM platform_projection_wake_intents ORDER BY projection_name",
        )
      ).rows;
      expect(intents.length).toBeGreaterThan(0);
      expect(intents.every((intent) => requiredNames.includes(intent.projection_name))).toBe(true);
      for (const intent of intents) {
        if (intent.projection_name === adminName) {
          expect(intent.last_error).toMatchObject({ reason: "projection-group-lease-busy" });
        } else {
          expect(intent.last_error).toBeNull();
        }
      }
      expect(intents.every((intent) => intent.state === "completed")).toBe(true);
      const applications = await pool.query<{ status: string }>(
        `SELECT status
       FROM event_subscription_applications
       WHERE event_id = $1
       ORDER BY updated_at DESC`,
        [committedEvent!.eventId],
      );
      expect(applications.rows.length).toBeGreaterThan(0);
      expect(applications.rows.every((row) => row.status === "applied")).toBe(true);
      const idleApplications = await pool.query<{ projection_key: string }>(
        "SELECT projection_key FROM event_subscription_applications WHERE event_id = $1 AND projection_key = ANY($2::text[])",
        [
          committedEvent!.eventId,
          projectionGroups
            .filter((group) =>
              ["catalog-field-projection", "catalog-display-template-projection", "catalog-alias-projection"].includes(
                group.projectionName,
              ),
            )
            .flatMap((group) => group.subscriptionRunners.map((runner) => runner.checkpointKey)),
        ],
      );
      expect(idleApplications.rows).toEqual([]);
      console.info(
        JSON.stringify({
          proof: "catalog-receipt-durable-next-read",
          afterReads,
          afterNextRead,
          intents,
          applications: applications.rows,
          trace,
          failures,
        }),
      );
    } finally {
      await wakeLoop.stop();
      await Promise.all(heldLeases.map((lease) => controlPlane.releaseLease(lease)));
    }
  });
});
