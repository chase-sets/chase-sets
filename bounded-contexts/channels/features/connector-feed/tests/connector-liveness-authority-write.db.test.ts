import { expect, it, vi } from "vitest";
import { describeDb, seller, target, transportContext, transportDatabase } from "./transport-test-support";

describeDb("connector-liveness-authority-write", () => {
  const h = transportDatabase("connector_liveness_write_7932");
  const read = () => h.services.connectorFeed.readConnectorLivenessAuthority({ connectionId: target.connectionId });
  it("advances each pairing mutation once, never resets heartbeat revision or reopens an ID", async () => {
    expect(await read()).toMatchObject({
      authorityGeneration: 2,
      heartbeatRevision: 0,
      livePairingId: h.pairingId,
      lastSeenAt: null,
    });
    expect((await h.request("claim")).status).toBe(200);
    const first = await read();
    expect(first).toMatchObject({
      authorityGeneration: 2,
      heartbeatRevision: 1,
      lastSeenAt: "2026-10-07T12:00:00.000Z",
      servedPollWindowSeconds: 60,
      heartbeatDueAt: "2026-10-07T12:01:00.000Z",
    });
    const detail = await h.services.connectorFeed.detail(target);
    expect(detail.lastSeenAt).toBe(first?.lastSeenAt);
    await h.services.connectorFeed.unpair(target, h.pairingId, detail.revision!, seller);
    expect(await read()).toMatchObject({
      authorityGeneration: 3,
      heartbeatRevision: 1,
      livePairingId: null,
      lastSeenAt: null,
      servedPollWindowSeconds: null,
      servedPolicyIdentity: null,
      heartbeatDueAt: null,
    });
    await h.services.connectorFeed.unpair(target, h.pairingId, detail.revision!, seller);
    expect((await read())?.authorityGeneration).toBe(3);
    const next = await h.pair();
    expect(next.pairingId).not.toBe(h.pairingId);
    expect(await read()).toMatchObject({ authorityGeneration: 5, heartbeatRevision: 1, livePairingId: next.pairingId });
    expect((await h.request("claim")).status).toBe(403);
    expect((await h.request("claim", {}, { token: next.token })).status).toBe(200);
    expect((await read())?.heartbeatRevision).toBe(2);
    expect(
      (await h.db.query("SELECT last_seen_at,served_poll_window_seconds FROM channel_connector_pairings")).rows,
    ).toEqual([
      expect.objectContaining({ last_seen_at: null, served_poll_window_seconds: null }),
      expect.objectContaining({ last_seen_at: null, served_poll_window_seconds: null }),
    ]);
  });
  it("serializes competing admitted polls, and equal/older clocks leave the whole row unchanged", async () => {
    const responses = await Promise.all([h.request("claim"), h.request("claim")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const first = await read();
    expect(first?.heartbeatRevision).toBe(1);
    vi.setSystemTime(new Date("2026-10-07T11:59:59Z"));
    expect((await h.request("claim")).status).toBe(200);
    expect(await read()).toEqual(first);
    vi.setSystemTime(new Date("2026-10-07T12:00:01Z"));
    expect((await h.request("claim")).status).toBe(200);
    expect(await read()).toMatchObject({ heartbeatRevision: 2, heartbeatDueAt: "2026-10-07T12:01:01.000Z" });
  });
  it("serializes competing replacements without losing a generation", async () => {
    await Promise.all([
      h.services.connectorFeed.createPairingCode(target, seller),
      h.services.connectorFeed.createPairingCode(target, seller),
    ]);
    expect(await read()).toMatchObject({ authorityGeneration: 6, heartbeatRevision: 0 });
    const rows = await h.db.query("SELECT pairing_id FROM channel_connector_pairings WHERE state <> 'closed'");
    expect(rows.rows).toHaveLength(1);
    expect((await read())?.livePairingId).toBe(rows.rows[0]?.pairing_id);
  });
  it.each(["membership", "credential", "body", "revoked"])(
    "pre-admission %s refusal leaves E2 untouched",
    async (reason) => {
      const before = await read();
      if (reason === "membership") await h.membership(false);
      if (reason === "revoked") await h.revokeAuthGrant();
      const response = await h.request(
        "claim",
        reason === "body" ? { unknown: true } : {},
        reason === "credential" ? { token: "invalid" } : {},
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await read()).toEqual(before);
    },
  );
  it("rejects partial persisted heartbeats and surfaces a pairing invariant breach", async () => {
    await expect(
      h.db.query(
        "UPDATE channel_connector_liveness_authority SET last_seen_at=now() WHERE connection_id=$1 AND authority_generation=2",
        [target.connectionId],
      ),
    ).rejects.toThrow();
    await h.db.query(
      "UPDATE channel_connector_liveness_authority SET live_pairing_id=$2 WHERE connection_id=$1 AND authority_generation=2",
      [target.connectionId, "pair_stale_old_pod"],
    );
    expect((await h.request("claim")).status).toBe(409);
    expect((await read())?.heartbeatRevision).toBe(0);
  });
  it("disconnect clears heartbeat once and retained disconnected state never reopens", async () => {
    await h.request("claim");
    await h.services.connections.disconnectChannelConnection(target, transportContext);
    await h.projectConnection();
    expect(await read()).toMatchObject({
      connectionStatus: "disconnected",
      authorityGeneration: 3,
      livePairingId: null,
      heartbeatRevision: 1,
      lastSeenAt: null,
    });
    expect((await h.request("claim")).status).toBe(403);
    await expect(h.services.connectorFeed.createPairingCode(target, seller)).rejects.toThrow();
  });
});
