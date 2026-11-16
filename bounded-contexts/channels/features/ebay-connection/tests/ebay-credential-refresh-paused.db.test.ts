import { describe, expect, it } from "vitest";
import { refreshFixture } from "./refresh-test-support";
import { signal } from "./db-support";
import { parseRefreshResponse } from "../domain/oauth";

describe("ebay-credential-refresh paused completion", () => {
  const f = refreshFixture("paused");
  async function lifecycle(
    r: ReturnType<typeof f.runtime>,
    connectionId: string,
    transition: "activated" | "paused" | "resumed",
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
                  credentialReference: (await f.envelopes())[0].row_id,
                  bindings: [{ storageLocationId: "location_synthetic", revision: 1 }],
                }
              : {}),
          },
        },
      ],
      context: f.context(),
    });
  }

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
    expect((await r.health.readConnectionHealth({ accountId: f.owner, connectionId })).health.reasons).toMatchObject([
      { reasonCode: "credential", state: "failing", consecutiveFailures: 1 },
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
