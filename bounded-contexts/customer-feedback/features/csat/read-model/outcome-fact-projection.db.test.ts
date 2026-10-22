import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainContextRuntime } from "@chase-sets/bounded-context-runtime";
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
import { module as customerFeedbackModule } from "../../../index";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_csat_projection",
  audit: { performedByUserId: "usr_projection_test", forAccountId: "acc_projection_test" },
};

describeDb("CSAT outcome projection against real rows and checkpoints", () => {
  let pools: Readonly<Record<"auth" | "identity" | "discovery" | "customer-feedback", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["auth", "identity", "discovery", "customer-feedback"],
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
    await bootstrapContextDatabase(customerFeedbackModule, pools["customer-feedback"]);
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
      { contextName: "customer-feedback", module: customerFeedbackModule, pool: pools["customer-feedback"], ports: {} },
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

  it("projects real Auth rows, replays idempotently, and resumes from the persisted first checkpoint", async () => {
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
    const runner = firstRuntime.subscriptionRunners.find(
      (candidate) =>
        candidate.sourceContextName === "auth" &&
        candidate.projectionName === "customer-feedback-csat-outcome-fact-projection",
    );
    expect(runner).toBeDefined();
    await runner!.runOnce();
    const firstCheckpoint = await pools["customer-feedback"].query<{ checkpoint: string }>(
      "SELECT last_global_position::text AS checkpoint FROM event_subscription_checkpoints WHERE checkpoint_key = $1",
      [runner!.checkpointKey],
    );
    expect(firstCheckpoint.rows[0]?.checkpoint).toBe("100");

    const restarted = runtime();
    await drainContextRuntime({
      subscriptionRunners: restarted.subscriptionRunners.filter(
        (candidate) => candidate.checkpointKey === runner!.checkpointKey,
      ),
    });
    await drainContextRuntime({
      subscriptionRunners: restarted.subscriptionRunners.filter(
        (candidate) => candidate.checkpointKey === runner!.checkpointKey,
      ),
    });
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
    await restarted.subscriptionRunners
      .find((candidate) => candidate.checkpointKey === runner!.checkpointKey)!
      .runOnce();
    const replayRows = await pools["customer-feedback"].query<{ count: string }>(
      "SELECT count(*)::text AS count FROM customer_feedback_csat_outcome_facts",
    );
    expect(replayRows.rows[0]?.count).toBe("102");
  });
});
