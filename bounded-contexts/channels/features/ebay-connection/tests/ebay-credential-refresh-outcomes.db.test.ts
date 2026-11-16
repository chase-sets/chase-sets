import { describe, expect, it } from "vitest";
import { refreshFixture, secretMarker } from "./refresh-test-support";
import { parseRefreshResponse } from "../domain/oauth";
import { signal } from "./db-support";

describe("ebay-credential-refresh-outcomes", () => {
  const f = refreshFixture("outcomes");
  it("retries a lost response with the retained grant; unmapped refusal retries through exact indexed backoffs and exhaustion", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    r.provider.refresh.mockRejectedValue(new Error(`synthetic-unmapped-refusal-${secretMarker}`));
    for (let n = 1; n <= 6; n++) {
      const claim = (await r.maintenance.claim())!;
      expect(claim.attempt).toBe(n);
      expect(await r.maintenance.process(claim)).toBe(true);
      const [row] = await f.rows();
      expect(row).toMatchObject({ attempt: n, lease_id: null, last_outcome: n === 6 ? "exhausted" : "retryable" });
      if (n < 6) {
        const seconds = [60, 300, 1800, 7200, 21600][n - 1];
        expect(row.due_at).toEqual(new Date(f.now().getTime() + seconds * 1000));
        expect(await r.maintenance.claim()).toBeNull();
        f.advance(seconds);
      } else expect(row.due_at).toBeNull();
    }
    expect(await r.maintenance.sweep()).toBe(0);
    expect(await f.observations()).toHaveLength(6);
    expect(
      r.provider.refresh.mock.calls.every(
        ([tokens]) => tokens.refresh.kind === "present" && tokens.refresh.token === secretMarker,
      ),
    ).toBe(true);
    expect((await f.rows())[0].last_outcome).not.toBe("terminal");
  });
  it("recovers the lost/timed-out response using S1 retained-token success shape without token reissue", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    r.provider.refresh.mockRejectedValueOnce(new Error("synthetic-lost-response"));
    expect(await r.maintenance.sweep()).toBe(1);
    f.advance(60);
    expect(await r.maintenance.sweep()).toBe(1);
    expect(r.provider.refresh.mock.calls[1][0].refresh).toMatchObject({ token: secretMarker });
    expect(await f.observations()).toMatchObject([
      { outcome: "failure", sourceAttempt: 1 },
      { outcome: "success", sourceAttempt: 2 },
    ]);
    expect(await f.rows()).toMatchObject([{ attempt: 0, last_outcome: "succeeded", schedule_generation: "2" }]);
  });
  it("synthetic unobserved terminal classification requires reconnect, never a fabricated eBay error mapping", async () => {
    const r = f.runtime({ terminal: true });
    await f.connect(r);
    f.advance(5400);
    r.provider.refresh.mockRejectedValue(new Error("SYNTHETIC_TERMINAL_CLASSIFICATION_NOT_PROVIDER_AUTHORITY"));
    await r.maintenance.sweep();
    expect(await f.rows()).toMatchObject([{ attempt: 1, last_outcome: "terminal", due_at: null }]);
    expect(await f.observations()).toMatchObject([{ reasonCode: "credential", outcome: "failure" }]);
    expect(await r.maintenance.sweep()).toBe(0);
    expect((await f.db().query("SELECT reason_code FROM channel_connection_attention")).rows).toEqual([
      { reason_code: "credential" },
    ]);
  });
  it.each([2250, 2249, 1])(
    "exchange admission %s records reconnect attention without a due schedule",
    async (lifetime) => {
      const r = f.runtime({ lifetime });
      await f.connect(r);
      expect(await f.rows()).toMatchObject([{ due_at: null, last_outcome: "terminal" }]);
      expect(await f.observations()).toMatchObject([{ outcome: "failure", reasonCode: "credential" }]);
      expect((await f.db().query("SELECT reason_code FROM channel_connection_attention")).rows).toEqual([
        { reason_code: "credential" },
      ]);
    },
  );
  it("refresh lifetime rejection preserves custody and has no retry", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    r.provider.refresh.mockImplementation(async (tokens) =>
      parseRefreshResponse(
        { access_token: "synthetic-too-short", expires_in: 2250, token_type: "User Access Token" },
        f.now().toISOString(),
        tokens,
      ),
    );
    await r.maintenance.sweep();
    expect(await f.envelopes()).toMatchObject([{ token_generation: "1" }]);
    expect(await f.rows()).toMatchObject([{ due_at: null, last_outcome: "terminal" }]);
  });
  it("delayed results cannot overwrite reauthorization or revive disconnected work", async () => {
    const r = f.runtime();
    const connected = await f.connect(r);
    f.advance(5400);
    const old = (await r.maintenance.claim())!;
    await r.service.callback(
      f.owner,
      await f.authorize(r, f.owner, connected.connectionId),
      "synthetic-code",
      f.context(),
    );
    expect(await r.maintenance.process(old)).toBe(false);
    const before = await f.envelopes();
    expect(before).toMatchObject([{ token_generation: "2" }]);
    await r.feed.disconnectChannelConnection({ accountId: f.owner, connectionId: connected.connectionId }, f.context());
    expect(await f.rows()).toEqual([]);
    expect(await r.maintenance.process(old)).toBe(false);
    expect(await f.envelopes()).toEqual([]);
  });
  it("an in-flight refresh finishing after reauthorization cannot write custody, schedule or observations", async () => {
    const r = f.runtime();
    const connected = await f.connect(r);
    f.advance(5400);
    const arrived = signal(),
      release = signal();
    r.provider.refresh.mockImplementationOnce(async (tokens) => {
      arrived.resolve();
      await release.promise;
      return parseRefreshResponse(
        { access_token: "synthetic-late-result", expires_in: 7200, token_type: "User Access Token" },
        f.now().toISOString(),
        tokens,
      );
    });
    const pending = r.maintenance.process((await r.maintenance.claim())!);
    await arrived.promise;
    await r.service.callback(
      f.owner,
      await f.authorize(r, f.owner, connected.connectionId),
      "synthetic-reauth",
      f.context(),
    );
    const successor = await f.rows();
    release.resolve();
    expect(await pending).toBe(false);
    expect(await f.rows()).toEqual(successor);
    expect(await f.observations()).toEqual([]);
    expect(await f.envelopes()).toMatchObject([{ token_generation: "2" }]);
  });
  it("ebay-credential-refresh-secret-scan keeps provider exception and token markers out of durable observations and events", async () => {
    const r = f.runtime();
    await f.connect(r);
    f.advance(5400);
    r.provider.refresh.mockRejectedValueOnce(new Error(`synthetic-provider-body-${secretMarker}`));
    await r.maintenance.sweep();
    f.advance(60);
    await r.maintenance.sweep();
    const records = await f.db().query(`SELECT to_jsonb(r) AS record FROM channels_ebay_credential_refresh r
      UNION ALL SELECT to_jsonb(o) FROM channels_ebay_credential_refresh_outcomes o
      UNION ALL SELECT to_jsonb(h) FROM channel_health_observations h
      UNION ALL SELECT to_jsonb(e) FROM event_store_events e`);
    const text = JSON.stringify(records.rows);
    for (const marker of [secretMarker, "synthetic-access-secret-marker", "synthetic-provider-body"])
      expect(text).not.toContain(marker);
  });
});
