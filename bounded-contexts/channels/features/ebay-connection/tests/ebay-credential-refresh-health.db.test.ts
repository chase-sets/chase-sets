import { describe, expect, it, vi } from "vitest";
import { refreshFixture } from "./refresh-test-support";
import { healthDigest } from "../../connection-health/domain/identity";
import { ebayMaintenanceRevision } from "../domain/credential-maintenance";
import { createChannelsEbayCredentialRefreshRunners } from "../../../support/runtime-support/worker-jobs";
import { module as channelsModule } from "../../../index";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { parseTokenResponse, parseRefreshResponse } from "../domain/oauth";
import { signal } from "./db-support";

describe("ebay-credential-refresh-health", () => {
  const f = refreshFixture("health");
  it("accepts two same-generation successes and later-cycle failure, then replays full payloads unchanged after restart", async () => {
    const r = f.runtime();
    const { connectionId } = await f.connect(r);
    for (let n = 0; n < 2; n++) {
      f.advance(5400);
      expect(await r.maintenance.sweep()).toBe(1);
    }
    r.provider.refresh.mockRejectedValueOnce(new Error("synthetic-refusal"));
    f.advance(5400);
    expect(await r.maintenance.sweep()).toBe(1);
    const observations = await f.observations();
    expect(observations).toHaveLength(3);
    expect(observations.map((o) => o.outcome)).toEqual(["success", "success", "failure"]);
    expect(new Set(observations.map((o) => o.sourceWorkId)).size).toBe(3);
    for (let i = 0; i < 3; i++)
      expect(observations[i]).toMatchObject({
        sourceWorkId: healthDigest(["ebay-credential-refresh", connectionId, 1, ebayMaintenanceRevision, i + 1]),
        sourceAttempt: 1,
      });
    expect(
      (await f.db().query("SELECT observation FROM channel_health_observations ORDER BY occurred_at")).rows.map(
        (r) => r.observation,
      ),
    ).toEqual(observations);
    const restarted = f.restart(r.provider);
    expect((await restarted.replay(connectionId)).map((o) => o.outcome)).toEqual(["replayed", "replayed", "replayed"]);
    expect(await f.observations()).toEqual(observations);
    expect(await f.rows()).toMatchObject([
      { token_generation: "1", schedule_generation: "3", attempt: 1, last_outcome: "retryable" },
    ]);
  });
  it("omitted-cycle-identity mutant conflicts with real health while cycle-qualified work is accepted", async () => {
    const r = f.runtime();
    const { connectionId } = await f.connect(r);
    f.advance(5400);
    await r.maintenance.sweep();
    f.advance(5400);
    await r.maintenance.sweep();
    const [first, second] = await f.observations();
    expect(
      (await r.health.submitObservation({ ...second, sourceWorkId: first.sourceWorkId }, f.context())).outcome,
    ).toBe("conflicting-terminal");
    expect((await r.health.submitObservation(second, f.context())).outcome).toBe("replayed");
    expect((await r.maintenance.replay(connectionId)).map((r) => r.outcome)).toEqual(["replayed", "replayed"]);
  });
  it("accepts material-changing generations and closes a failure with matching stable credential authority", async () => {
    const r = f.runtime({ changedMaterial: true });
    const { connectionId } = await f.connect(r);
    f.advance(5400);
    await r.maintenance.sweep();
    f.advance(5400);
    await r.maintenance.sweep();
    r.provider.refresh.mockRejectedValueOnce(new Error("synthetic-lost-response"));
    f.advance(5400);
    await r.maintenance.sweep();
    f.advance(60);
    await r.maintenance.sweep();
    const observations = await f.observations();
    expect(observations.map((o) => o.outcome)).toEqual(["success", "success", "failure", "success"]);
    expect(observations.map((o) => o.fingerprint)).toEqual([
      observations[0].fingerprint,
      observations[0].fingerprint,
      observations[2].fingerprint,
      observations[2].fingerprint,
    ]);
    expect(observations[2].fingerprint).not.toBe(observations[0].fingerprint);
    const accepted = await f.db().query("SELECT observation FROM channel_health_observations ORDER BY occurred_at");
    expect(accepted.rows.map((row) => row.observation)).toEqual(observations);
    expect((await r.health.readConnectionHealth({ connectionId, accountId: f.owner })).health.reasons).toMatchObject([
      { reasonCode: "credential", state: "closed", consecutiveFailures: 0 },
    ]);
    expect((await r.maintenance.replay(connectionId)).map((o) => o.outcome)).toEqual([
      "replayed",
      "replayed",
      "replayed",
      "replayed",
    ]);
    expect(await f.envelopes()).toMatchObject([{ token_generation: "4" }]);
  });
  it.each(["lifetime", "exhausted"])(
    "reauthorization after %s attention permits a later-generation success to close attention and replay",
    async (mode) => {
      const r = f.runtime({ lifetime: mode === "lifetime" ? 2250 : 7200 });
      const { connectionId } = await f.connect(r);
      if (mode === "exhausted") {
        f.advance(5400);
        r.provider.refresh.mockRejectedValue(new Error("synthetic-unmapped-refusal"));
        for (let n = 0; n < 6; n++) {
          await r.maintenance.sweep();
          if (n < 5) f.advance([60, 300, 1800, 7200, 21600][n]);
        }
      }
      expect((await f.db().query("SELECT resolved_at FROM channel_connection_attention")).rows).toEqual([
        { resolved_at: null },
      ]);
      r.provider.exchange.mockResolvedValue(
        parseTokenResponse(
          {
            access_token: "synthetic-reconnected-access",
            refresh_token: "synthetic-reconnected-refresh",
            expires_in: 7200,
            refresh_token_expires_in: 1000000,
            token_type: "User Access Token",
          },
          f.now().toISOString(),
        ),
      );
      await r.service.callback(
        f.owner,
        await f.authorize(r, f.owner, connectionId),
        "synthetic-reauthorization",
        f.context(),
      );
      r.provider.refresh.mockImplementation(async (tokens) =>
        parseRefreshResponse(
          { access_token: tokens.accessToken, expires_in: 7200, token_type: "User Access Token" },
          f.now().toISOString(),
          tokens,
        ),
      );
      f.advance(5400);
      expect(await r.maintenance.sweep()).toBe(1);
      expect((await r.health.readConnectionHealth({ connectionId, accountId: f.owner })).health.reasons).toMatchObject([
        { reasonCode: "credential", state: "closed", consecutiveFailures: 0 },
      ]);
      expect(
        (await f.db().query("SELECT resolved_at,resolution_reason FROM channel_connection_attention")).rows,
      ).toEqual([{ resolved_at: f.now(), resolution_reason: "recovered-automatically" }]);
      expect((await r.maintenance.replay(connectionId)).every((result) => result.outcome === "replayed")).toBe(true);
    },
  );
  it.each(["exhausted", "lifetime"])(
    "reopens reconnect attention after successful cycles, %s and reauthorization without changing the health law",
    async (mode) => {
      const r = f.runtime();
      const { connectionId } = await f.connect(r);
      for (let i = 0; i < 2; i++) {
        f.advance(5400);
        await r.maintenance.sweep();
      }
      const before = await f.observations();
      expect(before[0].fingerprint).toBe(before[1].fingerprint);
      f.advance(5400);
      if (mode === "exhausted") {
        r.provider.refresh.mockRejectedValue(new Error("synthetic-unmapped-refusal"));
        for (let n = 0; n < 6; n++) {
          await r.maintenance.sweep();
          if (n < 5) f.advance([60, 300, 1800, 7200, 21600][n]);
        }
      } else {
        r.provider.refresh.mockImplementationOnce(async (tokens) =>
          parseRefreshResponse(
            { access_token: tokens.accessToken, expires_in: 2250, token_type: "User Access Token" },
            f.now().toISOString(),
            tokens,
          ),
        );
        await r.maintenance.sweep();
      }
      const observations = await f.observations();
      const failures = observations.filter((o) => o.outcome === "failure");
      expect(failures).toHaveLength(mode === "exhausted" ? 6 : 1);
      expect(new Set(failures.map((o) => o.fingerprint)).size).toBe(1);
      expect(failures[0].fingerprint).not.toBe(before[0].fingerprint);
      expect(
        (
          await f
            .db()
            .query("SELECT reason_generation,resolved_at FROM channel_connection_attention ORDER BY reason_generation")
        ).rows,
      ).toEqual([
        { reason_generation: "1", resolved_at: new Date(before[0].occurredAt) },
        { reason_generation: "2", resolved_at: null },
      ]);
      expect((await f.rows())[0]).toMatchObject({
        last_outcome: mode === "exhausted" ? "exhausted" : "terminal",
        due_at: null,
      });
      await r.service.callback(
        f.owner,
        await f.authorize(r, f.owner, connectionId),
        "synthetic-reauthorization",
        f.context(),
      );
      r.provider.refresh.mockImplementation(async (tokens) =>
        parseRefreshResponse(
          { access_token: tokens.accessToken, expires_in: 7200, token_type: "User Access Token" },
          f.now().toISOString(),
          tokens,
        ),
      );
      f.advance(5400);
      await r.maintenance.sweep();
      expect(
        (await f.db().query("SELECT resolved_at FROM channel_connection_attention WHERE reason_generation=2")).rows,
      ).toEqual([{ resolved_at: f.now() }]);
      const after = await f.observations();
      expect(after.at(-1)!.fingerprint).toBe(failures[0].fingerprint);
      expect((await r.maintenance.replay(connectionId)).every((result) => result.outcome === "replayed")).toBe(true);
    },
  );
  it("the real registered runner drains durable work; omitted-runner control leaves it due", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    const services = channelsModule.createServices(f.db(), {
      channelSaleRecorder: async () => {
        throw new Error("unused");
      },
    });
    const input = {
      services: { channels: { ...services, ebayConnection: r.service } },
      controlPlane: createPostgresPlatformControlPlane(f.db()),
    };
    vi.spyOn(input.controlPlane, "claimScheduledRunner").mockResolvedValueOnce(true);
    vi.spyOn(input.controlPlane, "recordScheduledRunnerCompleted").mockResolvedValue(undefined);
    const runners = createChannelsEbayCredentialRefreshRunners(input);
    expect(runners.map((r) => r.name)).toEqual(["channels.ebay-credential-refresh"]);
    for (const runner of runners.filter(() => false)) await runner.runOnce();
    expect(await f.observations()).toEqual([]);
    await runners[0].runOnce();
    expect(await f.observations()).toMatchObject([{ outcome: "success" }]);
  });
});

describe("ebay-credential-refresh paused completion", () => {
  const f = refreshFixture("paused");
  async function lifecycle(
    r: ReturnType<typeof f.runtime>,
    connectionId: string,
    transition: "activated" | "paused" | "resumed",
    accountId = f.owner,
  ) {
    await r.eventStore.appendToStream({
      streamId: `channels.connection-${connectionId}`,
      expectedVersion: "any",
      events: [
        {
          eventType: `channels.connection.${transition}`,
          payload: {
            connectionId,
            ...(transition === "activated"
              ? {
                  credentialReference: (await f.envelopes()).find((row) => row.connection_id === connectionId)!.row_id,
                  bindings: [{ storageLocationId: "location_synthetic", revision: 1 }],
                }
              : {}),
          },
        },
      ],
      context: f.context(accountId),
    });
  }

  it("defers a paused unadmittable pre-slice seed while finishing healthy due work, then resumes with exactly one seed failure and reconnect attention", async () => {
    const r = f.runtime({ lifetime: 2250 });
    // Model legacy custody: the pre-slice callback did not initialize refresh maintenance.
    const initialize = vi.spyOn(r.maintenance, "initialize").mockResolvedValueOnce(undefined);
    const { connectionId } = await f.connect(r);
    initialize.mockRestore();
    await lifecycle(r, connectionId, "activated");
    await lifecycle(r, connectionId, "paused");
    const otherAccount = "acc_synthetic_unrelated";
    r.provider.identity.mockResolvedValueOnce("synthetic-unrelated-seller");
    r.provider.exchange.mockResolvedValueOnce(
      parseTokenResponse(
        {
          access_token: "synthetic-healthy-access",
          refresh_token: "synthetic-healthy-refresh",
          expires_in: 7200,
          refresh_token_expires_in: 1000000,
          token_type: "User Access Token",
        },
        f.now().toISOString(),
      ),
    );
    const healthy = await f.connect(r, otherAccount);
    await lifecycle(r, healthy.connectionId, "activated", otherAccount);
    f.advance(5400);
    const custody = await f
      .db()
      .query("SELECT to_jsonb(c) AS value FROM channels_connection_credentials c WHERE connection_id=$1", [
        connectionId,
      ]);
    expect(await r.maintenance.sweep()).toBe(1);
    expect(r.provider.refresh).toHaveBeenCalledOnce();
    expect(await f.rows()).toMatchObject([
      { connection_id: healthy.connectionId, attempt: 0, schedule_generation: "2", last_outcome: "succeeded" },
    ]);
    expect(await f.observations()).toMatchObject([{ connectionId: healthy.connectionId, outcome: "success" }]);
    const seedState = async () => ({
      schedule: (
        await f.db().query("SELECT 1 FROM channels_ebay_credential_refresh WHERE connection_id=$1", [connectionId])
      ).rows,
      journal: (await f.observations()).filter((o) => o.connectionId === connectionId),
      observations: (
        await f.db().query("SELECT observation FROM channel_health_observations WHERE connection_id=$1", [connectionId])
      ).rows,
      attention: (
        await f
          .db()
          .query("SELECT reason_code FROM channel_connection_attention WHERE connection_id=$1", [connectionId])
      ).rows,
    });
    expect(await seedState()).toEqual({ schedule: [], journal: [], observations: [], attention: [] });
    expect(await r.maintenance.sweep()).toBe(0);
    expect(await seedState()).toEqual({ schedule: [], journal: [], observations: [], attention: [] });
    expect(
      (
        await f
          .db()
          .query("SELECT to_jsonb(c) AS value FROM channels_connection_credentials c WHERE connection_id=$1", [
            connectionId,
          ])
      ).rows,
    ).toEqual(custody.rows);
    await lifecycle(r, connectionId, "resumed");
    expect(await r.maintenance.sweep()).toBe(0);
    expect((await f.rows()).filter((row) => row.connection_id === connectionId)).toMatchObject([
      { token_generation: "1", schedule_generation: "1", attempt: 0, due_at: null, last_outcome: "terminal" },
    ]);
    expect((await f.observations()).filter((o) => o.connectionId === connectionId)).toMatchObject([
      { sourceAttempt: 1, outcome: "failure", reasonCode: "credential" },
    ]);
    expect((await r.health.readConnectionHealth({ accountId: f.owner, connectionId })).health.reasons).toMatchObject([
      { reasonCode: "credential", state: "degraded", consecutiveFailures: 1 },
    ]);
    expect((await seedState()).attention).toEqual([{ reason_code: "credential" }]);
    expect(
      (
        await f
          .db()
          .query("SELECT resolved_at FROM channel_connection_attention WHERE connection_id=$1", [connectionId])
      ).rows,
    ).toEqual([{ resolved_at: null }]);
    expect(await r.maintenance.sweep()).toBe(0);
    expect((await r.maintenance.replay(connectionId)).map((result) => result.outcome)).toEqual(["replayed"]);
    const after = await seedState();
    expect(after.journal).toHaveLength(1);
    expect(after.observations.map((row) => row.observation)).toEqual(after.journal);
    expect(r.provider.refresh).toHaveBeenCalledOnce();
  });

  it("attempt-6 refusal on a paused connection does not finalize; resume recovers the same attempt with credential failure and reconnect attention, without duplicate observation", async () => {
    const r = f.runtime();
    const { connectionId } = await f.connect(r);
    await lifecycle(r, connectionId, "activated");
    f.advance(5400);
    await f.db().query("UPDATE channels_ebay_credential_refresh SET attempt=5,last_outcome='retryable'");
    const claim = (await r.maintenance.claim())!;
    expect(claim.attempt).toBe(6);
    await lifecycle(r, connectionId, "paused");
    const before = await f.rows();
    r.provider.refresh.mockRejectedValue(new Error("synthetic-unmapped-refusal"));
    expect(await r.maintenance.process(claim)).toBe(false);
    expect(r.provider.refresh).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual(before);
    expect(await f.observations()).toEqual([]);
    expect((await f.db().query("SELECT observation FROM channel_health_observations")).rows).toEqual([]);
    await lifecycle(r, connectionId, "resumed");
    f.advance(60);
    const recovered = (await r.maintenance.claim())!;
    expect(recovered).toMatchObject({ attempt: 6, schedule_generation: claim.schedule_generation });
    expect(recovered.lease_id).not.toBe(claim.lease_id);
    expect(await r.maintenance.process(recovered)).toBe(true);
    expect(await f.rows()).toMatchObject([{ attempt: 6, last_outcome: "exhausted", due_at: null }]);
    // Only the recovered attempt was observed; refresh retry budget is not the health failure count.
    expect((await r.health.readConnectionHealth({ accountId: f.owner, connectionId })).health.reasons).toMatchObject([
      {
        reasonCode: "credential",
        state: "degraded",
        consecutiveFailures: 1,
        trailingFailures: 1,
        opening: { sourceAttempt: 6 },
      },
    ]);
    expect((await f.db().query("SELECT reason_code,resolved_at FROM channel_connection_attention")).rows).toEqual([
      { reason_code: "credential", resolved_at: null },
    ]);
    expect(await r.maintenance.process(recovered)).toBe(false);
    expect((await r.maintenance.replay(connectionId)).map((result) => result.outcome)).toEqual(["replayed"]);
    expect(await f.observations()).toMatchObject([{ sourceAttempt: 6, outcome: "failure" }]);
    expect((await f.db().query("SELECT observation FROM channel_health_observations")).rows).toHaveLength(1);
  });

  it.each(["attempt-6 refusal", "short-lifetime rejection", "same-material success", "changed-material success"])(
    "pause arriving mid-refresh rolls back %s, then resume completes the same attempt/cycle",
    async (mode) => {
      const r = f.runtime({ changedMaterial: mode === "changed-material success" });
      const { connectionId } = await f.connect(r);
      await lifecycle(r, connectionId, "activated");
      f.advance(5400);
      if (mode === "attempt-6 refusal")
        await f.db().query("UPDATE channels_ebay_credential_refresh SET attempt=5,last_outcome='retryable'");
      const arrived = signal(),
        release = signal();
      const refresh = r.provider.refresh.getMockImplementation()!;
      r.provider.refresh.mockImplementation(async (tokens) => {
        arrived.resolve();
        await release.promise;
        if (mode === "attempt-6 refusal") throw new Error("synthetic-unmapped-refusal");
        if (mode === "short-lifetime rejection")
          return parseRefreshResponse(
            { access_token: "synthetic-too-short", expires_in: 2250, token_type: "User Access Token" },
            f.now().toISOString(),
            tokens,
          );
        return refresh(tokens);
      });
      const claim = (await r.maintenance.claim())!;
      const before = await f.rows();
      const custody = await f.db().query("SELECT to_jsonb(c) AS value FROM channels_connection_credentials c");
      const pending = r.maintenance.process(claim);
      await arrived.promise;
      await lifecycle(r, connectionId, "paused");
      release.resolve();
      expect(await pending).toBe(false);
      expect(await f.rows()).toEqual(before);
      expect((await f.db().query("SELECT to_jsonb(c) AS value FROM channels_connection_credentials c")).rows).toEqual(
        custody.rows,
      );
      expect(await f.observations()).toEqual([]);
      expect((await f.db().query("SELECT observation FROM channel_health_observations")).rows).toEqual([]);
      expect((await f.db().query("SELECT reason_code FROM channel_connection_attention")).rows).toEqual([]);
      await lifecycle(r, connectionId, "resumed");
      f.advance(60);
      const recovered = (await r.maintenance.claim())!;
      expect(recovered).toMatchObject({ attempt: claim.attempt, schedule_generation: claim.schedule_generation });
      expect(await r.maintenance.process(recovered)).toBe(true);
      const success = mode.endsWith("success");
      expect(await f.rows()).toMatchObject([
        success
          ? {
              attempt: 0,
              last_outcome: "succeeded",
              token_generation: mode === "changed-material success" ? "2" : "1",
              schedule_generation: mode === "changed-material success" ? "1" : "2",
            }
          : {
              attempt: claim.attempt,
              last_outcome: mode === "attempt-6 refusal" ? "exhausted" : "terminal",
              due_at: null,
            },
      ]);
      expect(await f.observations()).toMatchObject([
        { sourceAttempt: claim.attempt, outcome: success ? "success" : "failure" },
      ]);
      expect((await r.maintenance.replay(connectionId)).map((result) => result.outcome)).toEqual(["replayed"]);
      expect((await f.db().query("SELECT observation FROM channel_health_observations")).rows).toHaveLength(1);
      expect(
        (await f.db().query("SELECT reason_code FROM channel_connection_attention WHERE resolved_at IS NULL")).rows,
      ).toEqual(success ? [] : [{ reason_code: "credential" }]);
    },
  );
});
