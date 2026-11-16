import { describe, expect, it, vi } from "vitest";
import { refreshFixture } from "./refresh-test-support";
import { healthDigest } from "../../connection-health/domain/identity";
import { ebayMaintenanceRevision } from "../domain/credential-maintenance";
import { createChannelsEbayCredentialRefreshRunners } from "../../../support/runtime-support/worker-jobs";
import { module as channelsModule } from "../../../index";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { parseTokenResponse, parseRefreshResponse } from "../domain/oauth";

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
    expect(new Set(observations.map((o) => o.fingerprint)).size).toBe(1);
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
