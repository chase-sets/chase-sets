import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createMountedContextTestRuntime } from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as authModule } from "../../../../auth/index";
import { module as identityModule } from "../../../../identity/index";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../../../identity/features/account-capabilities/api/authority";
import { module as discoveryModule } from "../../../../discovery/index";
import { module as notificationsModule } from "../../../../notifications/index";
import { module as fulfillmentModule } from "../../../../fulfillment/index";
import { module as paymentsModule } from "../../../../payments/index";
import { module as settlementModule } from "../../../../settlement/index";
import { module as platformOperationsModule } from "../../../../platform-operations/index";
import { module as customerFeedbackModule } from "../../../index";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { buildAuthOutcomeFactProjectionHandlers } from "../integrations/auth/outcome-fact-projection";
import { deliveryFact, captureFact, payoutFact, supportFact } from "../../../tests/wave-two-outcome-fact-test-support";
import { outcomeHandlers } from "../../../tests/outcome-fact-test-support";

const sourceModules = {
  fulfillment: fulfillmentModule,
  payments: paymentsModule,
  settlement: settlementModule,
  "platform-operations": platformOperationsModule,
} as const;

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_csat_projection",
  audit: { performedByUserId: "usr_projection_test", forAccountId: "acc_projection_test" },
};

describeDb("CSAT outcome projection against real rows and checkpoints", () => {
  let pools: Readonly<
    Record<
      "auth" | "identity" | "discovery" | "notifications" | "customer-feedback" | keyof typeof sourceModules,
      PgTransactionalPool
    >
  >;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["auth", "identity", "discovery", "notifications", "customer-feedback", ...Object.keys(sourceModules)],
      "csat_outcome_projection",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
    await bootstrapContextDatabase(discoveryModule, pools.discovery);
    await bootstrapContextDatabase(notificationsModule, pools.notifications);
    await bootstrapContextDatabase(customerFeedbackModule, pools["customer-feedback"]);
    for (const [name, module] of Object.entries(sourceModules)) {
      await bootstrapContextDatabase(module, pools[name as keyof typeof sourceModules]);
    }
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime() {
    return createMountedContextTestRuntime([
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identityModule,
        pool: pools.identity,
        ports: { capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY },
      },
      { contextName: "auth", mountRole: "source-only", module: authModule, pool: pools.auth, ports: {} },
      { contextName: "discovery", mountRole: "source-only", module: discoveryModule, pool: pools.discovery, ports: {} },
      {
        contextName: "notifications",
        mountRole: "source-only",
        module: notificationsModule,
        pool: pools.notifications,
        ports: {},
      },
      { contextName: "customer-feedback", module: customerFeedbackModule, pool: pools["customer-feedback"], ports: {} },
      ...Object.entries(sourceModules).map(([contextName, module]) => ({
        contextName,
        module,
        mountRole: "source-only" as const,
        pool: pools[contextName as keyof typeof sourceModules],
        ports: {},
      })),
    ]);
  }

  async function appendAuthEvents(count: number) {
    const store = createPostgresEventStore({ pool: pools.auth });
    for (let index = 0; index < count; index += 1) {
      const sessionId = `ses_csat_${index}`;
      await store.appendToStream({
        streamId: `auth.session-${sessionId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventId: `evt_csat_${index}`,
            eventType: "auth.session.started",
            payload: {
              sessionId,
              userId: `usr_csat_${index}`,
              accountId: `acc_csat_${index}`,
              availableAccountIds: [`acc_csat_${index}`],
              authenticationMethod: "password",
              expiresAt: "2027-01-01T00:00:00.000Z",
            },
          },
        ],
      });
    }
  }

  it("recovers all four native sources from zero, fences checkpoints and resumes immutable rows", async () => {
    const nativeFacts = {
      fulfillment: deliveryFact(),
      payments: captureFact(null),
      settlement: payoutFact(),
      "platform-operations": supportFact("return-request"),
    };
    for (const [source, fact] of Object.entries(nativeFacts)) {
      const entity = {
        fulfillment: "orderId",
        payments: "paymentId",
        settlement: "payoutId",
        "platform-operations": "supportRequestId",
      }[source as keyof typeof sourceModules];
      await createPostgresEventStore({ pool: pools[source as keyof typeof sourceModules] }).appendToStream({
        streamId: `${source}.synthetic-outcomes`,
        expectedVersion: "no_stream",
        context,
        events: Array.from({ length: 101 }, (_, index) => ({
          eventId: `evt_${source}_${index}`,
          eventType: fact.type,
          payload: {
            ...fact.data,
            [entity]: `${fact.data[entity as keyof typeof fact.data]}_${index}`,
          },
        })),
      });
    }
    const first = runtime();
    const group = first.projectionGroups.find(
      (candidate) => candidate.projectionName === "customer-feedback-csat-outcome-fact-projection",
    )!;
    expect(group.requiredDuringBootstrap).toBe(false);
    const runners = first.subscriptionRunners.filter(
      (candidate) => candidate.projectionName === group.projectionName && candidate.sourceContextName in nativeFacts,
    );
    expect(runners).toHaveLength(4);
    for (const runner of runners) {
      expect(runner.checkpointKey).toBe(`${group.projectionName}:${runner.sourceContextName}:v1`);
      expect(runner.checkpointBatchSize).toBe(100);
      expect((await runner.runOnce({ ownerId: "wave-two-first", fencingToken: "1" })).processed).toBe(100);
      const lost = new Error("synthetic lost lease");
      await expect(
        runner.runOnce({
          ownerId: "wave-two-first",
          fencingToken: "1",
          throwIfLeaseLost: () => {
            throw lost;
          },
        }),
      ).rejects.toBe(lost);
    }
    const restarted = runtime();
    for (const runner of runners) {
      const resumed = restarted.subscriptionRunners.find(
        (candidate) => candidate.checkpointKey === runner.checkpointKey,
      )!;
      expect((await resumed.runOnce({ ownerId: "wave-two-restarted", fencingToken: "2" })).processed).toBe(1);
      const checkpoint = await pools["customer-feedback"].query(
        "SELECT last_global_position::text AS position, lease_owner_id AS owner, lease_fencing_token::text AS fence FROM event_subscription_checkpoints WHERE checkpoint_key = $1",
        [runner.checkpointKey],
      );
      expect(checkpoint.rows).toEqual([{ position: "101", owner: "wave-two-restarted", fence: "2" }]);
      const history = await createPostgresEventStore({
        pool: pools[runner.sourceContextName as keyof typeof sourceModules],
      }).readAll({ limit: 100 });
      const before = await pools["customer-feedback"].query(
        "SELECT * FROM customer_feedback_csat_outcome_facts ORDER BY idempotency_key",
      );
      for (const event of history) {
        await outcomeHandlers[event.eventType]!(toTransportEvent({ ...event, eventId: "evt_redelivery" as never }), {
          db: pools["customer-feedback"],
        });
      }
      expect(
        (
          await pools["customer-feedback"].query(
            "SELECT * FROM customer_feedback_csat_outcome_facts ORDER BY idempotency_key",
          )
        ).rows,
      ).toEqual(before.rows);
      expect((await resumed.runOnce({ ownerId: "wave-two-restarted", fencingToken: "2" })).processed).toBe(0);
    }
    expect(
      (await pools["customer-feedback"].query("SELECT idempotency_key FROM customer_feedback_csat_outcome_facts")).rows,
    ).toHaveLength(404);
  });

  it("catches up Auth history in 100-event checkpointed batches and resumes exactly once", async () => {
    await appendAuthEvents(101);
    await createPostgresEventStore({ pool: pools.auth }).appendToStream({
      streamId: "auth.session-legacy",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventId: "evt_csat_legacy",
          eventType: "auth.session.started",
          payload: {
            sessionId: "ses_csat_legacy",
            userId: "usr_csat_legacy",
            accountId: "acc_csat_legacy",
            availableAccountIds: ["acc_csat_legacy"],
            expiresAt: "2027-01-01T00:00:00.000Z",
          } as never,
        },
      ],
    });
    const firstRuntime = runtime();
    const group = firstRuntime.projectionGroups.find(
      (candidate) => candidate.projectionName === "customer-feedback-csat-outcome-fact-projection",
    )!;
    expect(group.requiredDuringBootstrap).toBe(false);
    const calls = firstRuntime.subscriptionRunners.map((candidate) => vi.spyOn(candidate, "runOnce"));
    const registry = firstRuntime.mountedContexts.map((mounted) => ({
      contextName: mounted.contextName,
      packageName: `@chase-sets/${mounted.contextName}`,
      manifest: { contextName: mounted.contextName, apiDeployables: ["platform-api"] },
      module: mounted.module,
    }));
    // The real host bootstrap returns while all 102 historical facts remain pending.
    await seedApiHostIfEmpty(
      registry,
      "platform-api",
      {
        ...firstRuntime,
        accountCapabilityRegistry: [],
        mountedModules: firstRuntime.mountedContexts.map(({ module, services }) => ({ module, services })),
      },
      {
        enabledDataProfiles: [],
        environmentName: "production",
        projectionGroupLeasePort: {
          runWithLease: async (_group, _signal, work) => work({ ownerId: "bootstrap", fencingToken: "1" }),
        },
      },
    );
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(
      (await pools["customer-feedback"].query("SELECT idempotency_key FROM customer_feedback_csat_outcome_facts")).rows,
    ).toEqual([]);
    const runner = firstRuntime.subscriptionRunners.find(
      (candidate) =>
        candidate.sourceContextName === "auth" &&
        candidate.projectionName === "customer-feedback-csat-outcome-fact-projection",
    );
    expect(runner).toBeDefined();
    expect(runner!.checkpointBatchSize).toBe(100);
    const throwIfLeaseLost = vi.fn();
    const firstPass = await runner!.runOnce({ ownerId: "worker-first", fencingToken: "2", throwIfLeaseLost });
    expect(firstPass.processed).toBe(100);
    expect(throwIfLeaseLost).toHaveBeenCalled();
    const firstCheckpoint = await pools["customer-feedback"].query<{
      checkpoint: string;
      owner: string;
      fence: string;
    }>(
      "SELECT last_global_position::text AS checkpoint, lease_owner_id AS owner, lease_fencing_token::text AS fence FROM event_subscription_checkpoints WHERE checkpoint_key = $1",
      [runner!.checkpointKey],
    );
    expect(firstCheckpoint.rows).toEqual([{ checkpoint: "100", owner: "worker-first", fence: "2" }]);
    const leaseLost = new Error("synthetic lease lost after the first checkpoint");
    await expect(
      runner!.runOnce({
        ownerId: "worker-first",
        fencingToken: "2",
        throwIfLeaseLost: () => {
          throw leaseLost;
        },
      }),
    ).rejects.toBe(leaseLost);
    expect(
      (await pools["customer-feedback"].query("SELECT idempotency_key FROM customer_feedback_csat_outcome_facts")).rows,
    ).toHaveLength(100);

    const restarted = runtime();
    const resumed = restarted.subscriptionRunners.find(
      (candidate) => candidate.checkpointKey === runner!.checkpointKey,
    )!;
    const secondPass = await resumed.runOnce({ ownerId: "worker-restarted", fencingToken: "3" });
    expect(secondPass.processed).toBe(2);
    expect(secondPass.lastGlobalPosition).toBe("102");
    const checkpoint = await pools["customer-feedback"].query<{ checkpoint: string; owner: string; fence: string }>(
      "SELECT last_global_position::text AS checkpoint, lease_owner_id AS owner, lease_fencing_token::text AS fence FROM event_subscription_checkpoints WHERE checkpoint_key = $1",
      [resumed.checkpointKey],
    );
    expect(checkpoint.rows).toEqual([{ checkpoint: "102", owner: "worker-restarted", fence: "3" }]);
    const rows = await pools["customer-feedback"].query<{
      idempotency_key: string;
      source_event_id: string;
      authentication_method: string;
    }>(
      "SELECT idempotency_key, source_event_id, authentication_method FROM customer_feedback_csat_outcome_facts ORDER BY idempotency_key",
    );
    expect(rows.rows).toHaveLength(102);
    expect(rows.rows[0]).toMatchObject({ authentication_method: "password" });
    expect(rows.rows.find((row) => row.source_event_id === "evt_csat_legacy")).toMatchObject({
      authentication_method: null,
    });
    // Actual redelivery, not another empty run at an already advanced checkpoint.
    const handler = buildAuthOutcomeFactProjectionHandlers()["auth.session.started"]!;
    const history = await createPostgresEventStore({ pool: pools.auth }).readAll({ limit: 100 });
    for (const event of history) {
      await handler(toTransportEvent(event), { db: pools["customer-feedback"] });
      await handler(toTransportEvent(event), { db: pools["customer-feedback"] });
    }
    expect((await resumed.runOnce({ ownerId: "worker-restarted", fencingToken: "3" })).processed).toBe(0);
    const replayRows = await pools["customer-feedback"].query<{ count: string }>(
      "SELECT count(*)::text AS count FROM customer_feedback_csat_outcome_facts",
    );
    expect(replayRows.rows[0]?.count).toBe("102");
  });
});
