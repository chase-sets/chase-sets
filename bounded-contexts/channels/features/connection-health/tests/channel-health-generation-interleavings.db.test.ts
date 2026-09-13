import { expect, it } from "vitest";
import { channelConnectionStatuses } from "../../connections/domain/contracts";
import { healthDigest } from "../domain/identity";
import { decodeChannelHealthChanged } from "../domain/codecs";
import { channelHealthStates } from "../domain/contracts";
import { writeHealthSnapshot } from "../read-model/store";
import { context, describeDb, healthDatabase } from "./test-support";

describeDb("channel-health-generation-interleavings", () => {
  const h = healthDatabase("health_generations");
  it.each([
    { fingerprint: "A", generation: 3, failures: 1, facts: 3 },
    { fingerprint: "C", generation: 3, failures: 1, facts: 3 },
    { fingerprint: "B", generation: 2, failures: 2, facts: 2 },
  ])("accepts A -> B -> $fingerprint with durable generation $generation", async (expected) => {
    const id = await h.connection();
    const first = await h.observation(id, "polling", { fingerprint: healthDigest("synthetic-A") });
    const second = { ...first, sourceAttempt: 2, fingerprint: healthDigest("synthetic-B") };
    const third = {
      ...first,
      sourceAttempt: 3,
      fingerprint: healthDigest(`synthetic-${expected.fingerprint}`),
    };
    expect((await h.services.connectionHealth.submitObservation(first, context)).outcome).toBe("accepted");
    expect((await h.services.connectionHealth.submitObservation(second, context)).outcome).toBe("accepted");
    const result = await h.services.connectionHealth.submitObservation(third, context);
    expect(result.outcome).toBe("accepted");
    const reason = {
      reasonCode: "polling",
      fingerprint: third.fingerprint,
      generation: expected.generation,
      state: "degraded",
      consecutiveFailures: expected.failures,
      trailingFailures: expected.failures,
      opening: {
        sourceWorkId: first.sourceWorkId,
        sourceAttempt: expected.generation === 3 ? 3 : 2,
        occurredAt: first.occurredAt,
      },
    };
    expect(result.health.health.reasons).toEqual([expect.objectContaining(reason)]);
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.reasons).toEqual([
      expect.objectContaining(reason),
    ]);
    const ledger = await h.db.query<{ reason_generation: string; observation: unknown }>(
      `SELECT reason_generation, observation FROM channel_health_observations
      WHERE connection_id = $1 ORDER BY source_attempt`,
      [id],
    );
    expect(ledger.rows).toEqual([
      { reason_generation: "1", observation: first },
      { reason_generation: "2", observation: second },
      { reason_generation: String(expected.generation), observation: third },
    ]);
    const facts = await h.db.query<{ payload: unknown }>(
      "SELECT payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
      [`channels.connection-health-${id}`],
    );
    expect(facts.rows).toHaveLength(expected.facts);
    expect(decodeChannelHealthChanged(facts.rows.at(-1)!.payload)).toMatchObject({
      connection: h.query(id),
      reasonCode: "polling",
      generation: expected.generation,
      diagnosticCode: "reason-opened",
    });
  });

  it("retains opening lineage and rejects stale success, old fingerprints and old attempts", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    const opening = (await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0];
    const next = { ...first, sourceAttempt: 2, occurredAt: new Date().toISOString() };
    await h.services.connectionHealth.submitObservation(next, context);
    expect((await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0].opening).toEqual(
      opening.opening,
    );
    const changed = { ...next, sourceAttempt: 3, fingerprint: healthDigest("synthetic-new-setup") };
    await h.services.connectionHealth.submitObservation(changed, context);
    expect((await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0]).toMatchObject({
      generation: 2,
      consecutiveFailures: 1,
      trailingFailures: 1,
      opening: { sourceWorkId: first.sourceWorkId, sourceAttempt: 3, occurredAt: changed.occurredAt },
    });
    expect(
      (await h.services.connectionHealth.submitObservation({ ...first, sourceAttempt: 4, outcome: "success" }, context))
        .outcome,
    ).toBe("stale");
    expect((await h.services.connectionHealth.submitObservation({ ...first, sourceAttempt: 5 }, context)).outcome).toBe(
      "stale",
    );
    expect(
      (
        await h.services.connectionHealth.submitObservation(
          { ...changed, sourceAttempt: 4, outcome: "success", occurredAt: "2020-01-01T00:00:00Z" },
          context,
        )
      ).outcome,
    ).toBe("stale");
  });

  it("a real blocked stale writer affects zero rows after a newer generation commits", async () => {
    const id = await h.connection();
    const observation = await h.observation(id);
    await h.services.connectionHealth.submitObservation(observation, context);
    const previous = (await h.services.connectionHealth.readConnectionHealth(h.query(id))).health;
    const newer = {
      ...previous,
      reasons: previous.reasons.map((reason) => ({
        ...reason,
        generation: reason.generation + 1,
        fingerprint: healthDigest("newer"),
      })),
    };
    const owner = await h.db.connect();
    const waiter = await h.db.connect();
    await owner.query("BEGIN");
    await waiter.query("BEGIN");
    try {
      expect(await writeHealthSnapshot(owner, id, previous, newer)).toBe(1);
      const pid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const staleWrite = writeHealthSnapshot(waiter, id, previous, { ...previous, state: "healthy", reasons: [] });
      await expect
        .poll(
          async () =>
            (
              await h.db.query<{ wait_event_type: string }>(
                "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
                [pid],
              )
            ).rows[0]?.wait_event_type,
        )
        .toBe("Lock");
      // The first transaction still owns the row. PostgreSQL rechecks the predicates after its commit.
      await owner.query("COMMIT");
      expect(await staleWrite).toBe(0);
      await waiter.query("COMMIT");
      const read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
      expect(read.health.reasons[0]).toMatchObject({
        generation: 2,
        fingerprint: healthDigest("newer"),
        state: "degraded",
      });
    } finally {
      await owner.query("ROLLBACK");
      await waiter.query("ROLLBACK");
      owner.release();
      waiter.release();
    }
    const sameGenerationStale = {
      ...newer,
      reasons: newer.reasons.map((reason) => ({ ...reason, fingerprint: healthDigest("wrong") })),
    };
    expect(await writeHealthSnapshot(h.db, id, sameGenerationStale, previous)).toBe(0);
    const wrongState = { ...newer, reasons: newer.reasons.map((reason) => ({ ...reason, state: "closed" as const })) };
    expect(await writeHealthSnapshot(h.db, id, wrongState, previous)).toBe(0);
    expect(await writeHealthSnapshot(h.db, id, { ...newer, evaluationGeneration: 2 }, previous)).toBe(0);
  });

  it("serializes actual new-generation intake before stale success through independent runtime instances", async () => {
    const id = await h.connection();
    const observation = await h.observation(id);
    await h.services.connectionHealth.submitObservation(observation, context);
    const other = (await import("../../../index")).module.createServices(h.db, {}).connectionHealth;
    const results = await Promise.all([
      h.services.connectionHealth.submitObservation(
        { ...observation, sourceAttempt: 2, fingerprint: healthDigest("second-generation") },
        context,
      ),
      other.submitObservation(
        { ...observation, sourceAttempt: 3, outcome: "success", occurredAt: "2020-01-01T00:00:00Z" },
        context,
      ),
    ]);
    expect(results.map((result) => result.outcome)).toEqual(["accepted", "stale"]);
    expect((await other.readConnectionHealth(h.query(id))).health.reasons[0].state).toBe("degraded");
  });
});

describeDb("channel-health-day-after", () => {
  const h = healthDatabase("health_day_after");
  it.each(["paused", "disconnected"] as const)(
    "keeps first health reads and submissions for %s free of health writes",
    async (status) => {
      const id = await h.connection(status);
      const observation = await h.observation(id);
      const result = await h.services.connectionHealth.submitObservation(observation, context);
      expect(result).toMatchObject({
        outcome: "inert",
        health: { health: { state: "unknown", observedAt: null }, verifiedInboundSaleAllowed: true },
      });
      expect(
        (await h.db.query("SELECT 1 FROM channel_connection_health WHERE connection_id = $1", [id])).rows,
      ).toHaveLength(0);
      expect(
        (await h.db.query("SELECT 1 FROM channel_health_observations WHERE connection_id = $1", [id])).rows,
      ).toHaveLength(0);
    },
  );
  for (const status of channelConnectionStatuses)
    for (const health of channelHealthStates) {
      it(`reads ${status}/${health} and keeps paused or disconnected day-after observations inert`, async () => {
        const id = await h.connection(status === "pending-setup" ? "pending-setup" : "active");
        if (health === "healthy") await h.healthy(id);
        if (health === "degraded" || health === "failing") {
          const observation = await h.observation(id);
          for (let attempt = 1; attempt <= (health === "failing" ? 3 : 1); attempt++)
            await h.services.connectionHealth.submitObservation({ ...observation, sourceAttempt: attempt }, context);
        }
        const observation = await h.observation(id, "drift", { sourceAttempt: 2 });
        if (status === "paused") await h.services.connections.pauseChannelConnection(h.query(id), context);
        if (status === "disconnected") await h.services.connections.disconnectChannelConnection(h.query(id), context);
        const before = await h.services.connectionHealth.readConnectionHealth(h.query(id));
        expect(before.health.state).toBe(health);
        expect(before.connection.status).toBe(status);
        expect(before.verifiedInboundSaleAllowed).toBe(true);
        expect(before.outboundPublicationAllowed).toBe(
          status === "active" && (health === "healthy" || health === "degraded"),
        );
        const submitted = await h.services.connectionHealth.submitObservation(observation, context);
        expect(submitted.outcome).toBe(status === "paused" || status === "disconnected" ? "inert" : "accepted");
        if (status === "paused" || status === "disconnected") expect(submitted.health).toEqual(before);
        expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).connection.status).toBe(status);
      });
    }
  it("does not infer current connection authority from an absent projection", async () => {
    const id = await h.connection();
    const projection = await h.db.query("SELECT 1 FROM channel_connections WHERE connection_id = $1", [id]);
    expect(projection.rows).toHaveLength(0);
    await h.healthy(id);
    await h.services.connections.pauseChannelConnection(h.query(id), context);
    const read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read).toMatchObject({
      connection: { status: "paused" },
      health: { state: "healthy" },
      outboundPublicationAllowed: false,
      verifiedInboundSaleAllowed: true,
    });
  });
});
