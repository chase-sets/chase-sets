import { expect, it } from "vitest";
import { channelHealthPolicy } from "../domain/policy";
import { context, describeDb, healthDatabase } from "./test-support";

describeDb("channel-health-policy-revision", () => {
  const h = healthDatabase("health_policy");
  it("activates the real policy atomically, rejects older claims and never loosens an open pause", async () => {
    const id = await h.connection();
    const observation = await h.observation(id);
    await h.services.connectionHealth.submitObservation(observation, context);
    await h.policy({ windowSeconds: 900, consecutiveFailureThreshold: 1, failureBudgetCount: 5 });
    const newRuntime = (await import("../../../index")).module.createServices(h.db, {}).connectionHealth;
    const active = await newRuntime.readConnectionHealth(h.query(id));
    expect(active.health).toMatchObject({ state: "failing", evaluationGeneration: 2 });
    expect(active.health.policyRevision).not.toBe(observation.policyRevision);
    expect(
      (await newRuntime.submitObservation({ ...observation, sourceAttempt: 2, outcome: "success" }, context)).outcome,
    ).toBe("stale");
    await h.policy({ windowSeconds: 1, consecutiveFailureThreshold: 100, failureBudgetCount: 100 });
    const loosened = await newRuntime.readConnectionHealth(h.query(id));
    expect(loosened.health).toMatchObject({ state: "failing", evaluationGeneration: 3 });
    expect(loosened.health.observedAt).toBe(observation.occurredAt);
    const current = await h.observation(id, "polling", { outcome: "success" });
    expect((await newRuntime.submitObservation({ ...current, evaluationGeneration: 2 }, context)).outcome).toBe(
      "stale",
    );
    expect((await newRuntime.submitObservation(current, context)).outcome).toBe("accepted");
    expect((await newRuntime.readConnectionHealth(h.query(id))).systemPaused).toBe(false);
  });

  it("re-evaluates the new trailing window including successes without rewriting generated age", async () => {
    await h.policy(channelHealthPolicy.defaultValue);
    const id = await h.connection();
    const at = new Date(Date.now() - 60_000).toISOString();
    const observation = await h.observation(id, "polling", { occurredAt: at });
    await h.services.connectionHealth.submitObservation(observation, context);
    await h.policy({ windowSeconds: 1, consecutiveFailureThreshold: 3, failureBudgetCount: 5 });
    const read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read.health.reasons[0]).toMatchObject({ state: "degraded", trailingFailures: 0, consecutiveFailures: 1 });
    expect(read.health.observedAt).toBe(at);
    await h.policy({ windowSeconds: 900, consecutiveFailureThreshold: 3, failureBudgetCount: 1 });
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).systemPaused).toBe(true);
  });

  it("makes malformed policy values unavailable through the actual composed resolver", async () => {
    const id = await h.connection();
    await h.healthy(id);
    const observation = await h.observation(id);
    await h.db.query("UPDATE platform_policy_documents SET value = $1::jsonb WHERE policy_key = $2", [
      JSON.stringify({ windowSeconds: 0, consecutiveFailureThreshold: 3, failureBudgetCount: 5 }),
      channelHealthPolicy.policyKey,
    ]);
    const read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read.policyAvailable).toBe(false);
    expect(read.health.state).toBe("unknown");
    expect(read.outboundPublicationAllowed).toBe(false);
    expect((await h.services.connectionHealth.submitObservation(observation, context)).outcome).toBe(
      "policy-unavailable",
    );
  });

  it("waits for a real policy projection writer, then fences the old evaluation", async () => {
    await h.policy(channelHealthPolicy.defaultValue);
    const id = await h.connection();
    const observation = await h.observation(id);
    await h.services.connectionHealth.submitObservation(observation, context);
    const owner = await h.db.connect();
    await owner.query("BEGIN");
    try {
      await h.policy({ windowSeconds: 900, consecutiveFailureThreshold: 1, failureBudgetCount: 5 }, owner);
      const waiting = h.services.connectionHealth.readConnectionHealth(h.query(id));
      await expect
        .poll(
          async () =>
            (
              await h.db.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query = 'LOCK TABLE platform_policy_documents IN SHARE MODE'`)
            ).rows.length,
        )
        .toBeGreaterThan(0);
      await owner.query("COMMIT");
      const activated = await waiting;
      expect(activated.health.evaluationGeneration).toBe(observation.evaluationGeneration + 1);
      expect(activated.systemPaused).toBe(true);
      expect(
        (
          await h.services.connectionHealth.submitObservation(
            { ...observation, sourceAttempt: 2, outcome: "success" },
            context,
          )
        ).outcome,
      ).toBe("stale");
    } finally {
      await owner.query("ROLLBACK");
      owner.release();
    }
  });
});
