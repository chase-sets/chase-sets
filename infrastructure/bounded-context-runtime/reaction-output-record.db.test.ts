import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordCommittedEvents } from "@chase-sets/event-core";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "./schema";
import { createSubscriptionRunner } from "./subscriptions";
import { createProjectionAwarePool } from "./projection-transactions";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  createAccountUserTestRequestContext,
} from "./test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("reaction application output record", () => {
  let pools: Readonly<Record<"marketplace" | "ordering", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["marketplace", "ordering"], "reaction_outputs");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    for (const contextName of ["marketplace", "ordering"] as const) {
      await bootstrapContextDatabase({ contextName, schemaSql: "" }, pools[contextName]);
    }
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it.each(["one Order", "none", "throw after append", "projection"])("atomically records %s", async (control) => {
    const source = createPostgresEventStore({ pool: pools.marketplace });
    const target = createPostgresEventStore({ pool: createProjectionAwarePool(pools.ordering) });
    let shouldThrow = control === "throw after append";
    const [accepted] = await source.appendToStream({
      streamId: "marketplace.offer-test",
      expectedVersion: "no_stream",
      context: createAccountUserTestRequestContext().context!,
      events: [{ eventType: "marketplace.offer.accepted", payload: { offerId: "test" } }],
    });
    const runner = createSubscriptionRunner("ordering", pools.ordering, pools.marketplace, {
      subscriptionName: "ordering.accepted-offer",
      projectionName: "ordering.accepted-offer",
      sourceContextName: "marketplace",
      subscriptionVersion: 1,
      handlerKind: control === "projection" ? "projection" : "reaction",
      errorPolicy: "strict-per-stream",
      eventTypes: ["marketplace.offer.accepted"],
      handlers: {
        "marketplace.offer.accepted": async () => {
          if (control === "none") return;
          const events = await target.appendToStream({
            streamId: "ordering.order-test",
            expectedVersion: "no_stream",
            context: createAccountUserTestRequestContext().context!,
            events: [{ eventType: "ordering.order.created", payload: { orderId: "test" } }],
          });
          recordCommittedEvents(events);
          if (shouldThrow) throw new Error("rollback after append");
        },
      },
    });
    await runner.runOnce();
    const rows = await pools.ordering.query<{ status: string; output_global_positions: string[] | null }>(
      "SELECT status, output_global_positions FROM event_subscription_applications WHERE projection_key = $1 AND event_id = $2",
      [runner.checkpointKey, String(accepted!.eventId)],
    );
    const outputs = await target.readStream({ streamId: "ordering.order-test" });
    if (control === "throw after append") {
      expect(outputs).toHaveLength(0);
      expect(rows.rows).toEqual([{ status: "poison", output_global_positions: null }]);
      shouldThrow = false;
      await runner.retryBlockedStream("marketplace.offer-test");
      const retriedOutputs = await target.readStream({ streamId: "ordering.order-test" });
      expect(retriedOutputs).toHaveLength(1);
      expect(await runner.readReceiptApplicationOutputs!([String(accepted!.eventId)])).toEqual({
        state: "applied",
        outputPositions: retriedOutputs.map((event) => event.globalPosition),
      });
    } else {
      expect(outputs).toHaveLength(control === "none" ? 0 : 1);
      expect(rows.rows).toEqual([
        {
          status: "applied",
          output_global_positions: control === "projection" ? null : outputs.map((event) => event.globalPosition),
        },
      ]);
      if (control === "none") {
        const ids = [String(accepted!.eventId)];
        expect(await runner.readReceiptApplicationOutputs!(ids)).toEqual({ state: "applied", outputPositions: [] });
        await pools.ordering.query(
          "UPDATE event_subscription_applications SET output_global_positions = NULL WHERE projection_key = $1",
          [runner.checkpointKey],
        );
        expect(await runner.readReceiptApplicationOutputs!(ids)).toEqual({ state: "pending", outputPositions: [] });
        await pools.ordering.query("DELETE FROM event_subscription_applications WHERE projection_key = $1", [
          runner.checkpointKey,
        ]);
        expect(await runner.readReceiptApplicationOutputs!(ids)).toEqual({ state: "pending", outputPositions: [] });
      }
    }
  });
});
