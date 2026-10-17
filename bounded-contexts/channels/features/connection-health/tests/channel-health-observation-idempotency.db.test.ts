import { expect, it } from "vitest";
import { context, describeDb, healthDatabase } from "./test-support";
import { decodeChannelHealthChanged } from "../domain/codecs";

describeDb("channel-health-observation-idempotency", () => {
  const h = healthDatabase("health_identity");
  it("resolves a retained opening at a later ordinal without double-counting its attempt", async () => {
    const id = await h.connection();
    const observation = await h.observation(id, "polling", { sourceAttempt: 3 });
    await h.services.connectionHealth.submitObservation(observation, context);
    const opening = (await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0].opening;
    const resolution = { ...observation, ...opening, resultOrdinal: 2, outcome: "success" as const };
    expect((await h.services.connectionHealth.submitObservation(resolution, context)).outcome).toBe("accepted");
    expect((await h.services.connectionHealth.submitObservation(resolution, context)).outcome).toBe("replayed");
    expect(
      (await h.services.connectionHealth.submitObservation({ ...resolution, resultOrdinal: 3 }, context)).outcome,
    ).toBe("conflicting-terminal");
    expect(
      (await h.services.connectionHealth.submitObservation({ ...observation, sourceAttempt: 2 }, context)).outcome,
    ).toBe("stale");
    const read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read.health.reasons[0]).toMatchObject({ state: "closed", consecutiveFailures: 0, trailingFailures: 1 });
    expect(await h.services.connectionHealth.listOpenReasonGenerations(h.query(id))).toEqual([]);
    expect(
      (await h.services.connectionHealth.submitObservation({ ...observation, sourceAttempt: 4 }, context)).outcome,
    ).toBe("accepted");
    expect(
      (await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.reasons[0].trailingFailures,
    ).toBe(2);
  });
  it("ledgered boot migration installs both persistent tables and window indexes", async () => {
    const ledger = await h.db.query("SELECT 1 FROM bounded_context_schema_migrations WHERE migration_id = $1", [
      "20260912_channels_connection_health_v1",
    ]);
    expect(ledger.rows).toHaveLength(1);
    const indexes = await h.db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'channel_health_observations'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["channel_health_observations_window_idx", "channel_health_observations_fingerprint_idx"]),
    );
  });
  it("collapses concurrent tuple replay, counts a later same-code attempt once and rejects conflicting terminals", async () => {
    const id = await h.connection();
    const observation = await h.observation(id);
    const results = await Promise.all([
      h.services.connectionHealth.submitObservation(observation, context),
      h.services.connectionHealth.submitObservation(observation, context),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["accepted", "replayed"]);
    expect(
      (await h.services.connectionHealth.submitObservation({ ...observation, outcome: "success" }, context)).outcome,
    ).toBe("conflicting-terminal");
    expect(
      (await h.services.connectionHealth.submitObservation({ ...observation, resultOrdinal: 2 }, context)).outcome,
    ).toBe("conflicting-terminal");
    const later = { ...observation, sourceAttempt: 2 };
    expect((await h.services.connectionHealth.submitObservation(later, context)).outcome).toBe("accepted");
    expect((await h.services.connectionHealth.submitObservation(later, context)).outcome).toBe("replayed");
    const state = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(state.health.reasons[0]).toMatchObject({ generation: 1, consecutiveFailures: 2, trailingFailures: 2 });
    const rows = await h.db.query<{ source_work_id: string }>(
      "SELECT source_work_id FROM channel_health_observations WHERE connection_id = $1",
      [id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.source_work_id)).size).toBe(1);
  });

  it("uses OR, keeps trailing failures across success, isolates reasons, and resumes only after all close", async () => {
    const id = await h.connection();
    await h.healthy(id);
    const observation = await h.observation(id);
    for (let attempt = 2; attempt <= 10; attempt++) {
      await h.services.connectionHealth.submitObservation(
        { ...observation, sourceAttempt: attempt, outcome: attempt % 2 === 0 ? "failure" : "success" },
        context,
      );
    }
    let read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read.health.reasons.find((reason) => reason.reasonCode === "polling")).toMatchObject({
      consecutiveFailures: 1,
      trailingFailures: 5,
      state: "failing",
    });
    expect(read.systemPaused).toBe(true);
    expect(read.verifiedInboundSaleAllowed).toBe(true);
    const drift = await h.observation(id, "drift");
    for (let attempt = 2; attempt <= 4; attempt++)
      await h.services.connectionHealth.submitObservation({ ...drift, sourceAttempt: attempt }, context);
    await h.services.connectionHealth.submitObservation(
      { ...observation, sourceAttempt: 11, outcome: "success" },
      context,
    );
    read = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    expect(read.systemPaused).toBe(true);
    expect(read.health.reasons.find((reason) => reason.reasonCode === "drift")).toMatchObject({
      state: "failing",
      consecutiveFailures: 3,
      trailingFailures: 3,
    });
    await h.services.connectionHealth.submitObservation({ ...drift, sourceAttempt: 5, outcome: "success" }, context);
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.state).toBe("healthy");
    const lifecycle = await h.db.query<{ event_type: string }>(
      "SELECT event_type FROM event_store_events WHERE stream_id = $1",
      [`channels.connection-${id}`],
    );
    expect(lifecycle.rows.map((row) => row.event_type)).toEqual([
      "channels.connection.connected",
      "channels.connection.activated",
    ]);
  });

  it("preserves unknown and partial authority instead of fabricating historical health", async () => {
    const id = await h.connection();
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).health).toMatchObject({
      state: "unknown",
      observedAt: null,
    });
    await h.services.connectionHealth.submitObservation(
      await h.observation(id, "credential", { outcome: "success" }),
      context,
    );
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.state).toBe("unknown");
    await expect(
      h.services.connectionHealth.readConnectionHealth({ connectionId: id, accountId: "acc_foreign" }),
    ).rejects.toThrow("connection-not-found");
  });
  it("retains the latest real observation time across independently ordered reasons", async () => {
    const id = await h.connection();
    const recent = await h.observation(id);
    await h.services.connectionHealth.submitObservation(recent, context);
    await h.services.connectionHealth.submitObservation(
      await h.observation(id, "credential", { occurredAt: "2020-01-01T00:00:00Z", outcome: "success" }),
      context,
    );
    expect((await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.observedAt).toBe(
      recent.occurredAt,
    );
  });

  it("channel-health-artifact-secret-scan covers the actual intake, durable row and published fact", async () => {
    const id = await h.connection();
    const observation = await h.observation(id);
    const markers = ["credential=synthetic-secret", "seller@example.invalid", "raw-exception-body"];
    for (const marker of markers) {
      await expect(
        h.services.connectionHealth.submitObservation(
          { ...observation, rawProviderBody: marker } as typeof observation,
          context,
        ),
      ).rejects.toThrow("invalid-health-contract");
    }
    const before = await h.db.query("SELECT 1 FROM channel_health_observations WHERE connection_id = $1", [id]);
    expect(before.rows).toHaveLength(0);
    await h.services.connectionHealth.submitObservation(observation, context);
    const facts = await h.db.query<{ payload: unknown }>(
      "SELECT payload FROM event_store_events WHERE stream_id = $1",
      [`channels.connection-health-${id}`],
    );
    expect(facts.rows).toHaveLength(1);
    expect(decodeChannelHealthChanged(facts.rows[0].payload)).toMatchObject({
      reasonCode: "polling",
      generation: 1,
      diagnosticCode: "reason-opened",
    });
    const health = await h.services.connectionHealth.readConnectionHealth(h.query(id));
    const ledger = await h.db.query("SELECT observation FROM channel_health_observations WHERE connection_id = $1", [
      id,
    ]);
    const retained = JSON.stringify([facts.rows, health, ledger.rows]);
    for (const marker of markers) expect(retained).not.toContain(marker);
  });
});
