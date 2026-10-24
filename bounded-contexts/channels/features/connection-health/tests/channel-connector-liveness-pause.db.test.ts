import { expect, it, vi } from "vitest";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { connectorPolicyDefaults, connectorTransportPolicy } from "../../connector-feed/domain/policy";
import { evaluateConnectorLiveness } from "../domain/connector-liveness";
import { describeDb, livenessDatabase, seller, target, transportContext } from "./connector-liveness-test-support";

describeDb("channel-connector-liveness-pause", () => {
  const f = livenessDatabase("liveness_pause_7933");
  it("one missed window opens one failing reason; competing sweeps and later windows write nothing", async () => {
    await f.poll();
    const before = await f.effects();
    expect((await f.sweep("2026-10-07T12:00:59.999Z")).accepted).toBe(0);
    expect(await f.effects()).toEqual(before);
    const results = await Promise.all([f.sweep(), f.sweep()]);
    expect(results.reduce((sum, result) => sum + result.accepted, 0)).toBe(1);
    expect(await f.observations()).toHaveLength(1);
    expect(await f.open()).toMatchObject({ reasonCode: "connector-liveness", state: "failing", generation: 1 });
    expect(await f.health.readConnectionHealth(target)).toMatchObject({
      systemPaused: true,
      health: { state: "failing" },
    });
    expect(
      (
        await f.h.db.query(
          "SELECT 1 FROM event_store_events WHERE event_type='channels.connection.health-changed' AND payload->>'reasonCode'='connector-liveness'",
        )
      ).rows,
    ).toHaveLength(1);
    const stable = await f.effects();
    expect((await f.sweep("2026-10-07T12:05:00.000Z")).accepted).toBe(0);
    expect(await f.effects()).toEqual(stable);
  });

  it("S7 same-document/effectiveFrom revision and poll 2 cannot rewrite poll 1 opening identity or due", async () => {
    const documentId = await f.h.connectorPolicy(connectorPolicyDefaults);
    await f.poll();
    await f.sweep("2026-10-07T12:02:30.000Z");
    const open = (await f.open())!;
    const first = (await f.observations())[0];
    const resolver = createPolicyResolver({ db: f.h.db });
    const oldPolicy = await resolver.resolvePolicy(connectorTransportPolicy);
    const eventStore = createPostgresEventStore({ pool: f.h.db });
    const revised = await createPolicyRuntime({ eventStore, db: f.h.db }).revisePolicyDocument(
      connectorTransportPolicy,
      documentId,
      {
        status: "active",
        value: { ...connectorPolicyDefaults, pollWindowSeconds: 75 },
        effectiveFrom: oldPolicy.effectiveFrom!,
        effectiveUntil: oldPolicy.effectiveUntil,
        actorUserId: seller.userId,
      },
      transportContext,
    );
    const projector = f.h.services.projectors.find(
      (entry) => entry.projectionName === "platform-policy-document-projection",
    );
    if (!projector) throw new Error("missing-policy-projector");
    for (const event of await eventStore.readStream({
      streamId: `platform-policy.document-${documentId}`,
      fromVersion: revised.version,
    })) {
      await projector.handlers[event.eventType]?.(toTransportEvent(event));
    }
    const newPolicy = await resolver.resolvePolicy(connectorTransportPolicy);
    expect(newPolicy.documentId).toBe(oldPolicy.documentId);
    expect(newPolicy.effectiveFrom).toBe(oldPolicy.effectiveFrom);
    vi.setSystemTime(new Date("2026-10-07T12:03:00.000Z"));
    await f.poll();
    const authority = await f.h.services.connectorFeed.readConnectorLivenessAuthority({
      connectionId: target.connectionId,
    });
    expect(authority).toMatchObject({ heartbeatRevision: 2, heartbeatDueAt: "2026-10-07T12:04:15.000Z" });
    expect(await f.open()).toEqual(open);
    const health = (await f.health.readConnectionHealth(target)).health;
    const expected = evaluateConnectorLiveness({
      authority,
      openGeneration: open,
      now: "2026-10-07T12:03:00.000Z",
      ...health,
    });
    expect(expected).toMatchObject({
      sourceWorkId: open.opening.sourceWorkId,
      sourceAttempt: 2,
      resultOrdinal: 2,
      occurredAt: "2026-10-07T12:02:00.000Z",
    });
    expect((await f.sweep("2026-10-07T12:03:00.000Z")).accepted).toBe(1);
    expect(await f.observations()).toEqual([first, expected]);
    expect(await f.open()).toBeUndefined();
    const stable = await f.effects();
    await f.sweep("2026-10-07T12:03:00.000Z");
    expect(await f.effects()).toEqual(stable);
    expect((await f.sweep("2026-10-07T12:04:15.000Z")).accepted).toBe(1);
    expect(await f.open()).toMatchObject({ generation: 2, opening: { sourceAttempt: 1 } });
  });

  it("never-paired, paired-unserved and healthy steady states perform no writes", async () => {
    const before = await f.effects();
    await f.sweep();
    expect(await f.effects()).toEqual(before);
    await f.h.db.query("DELETE FROM channel_connector_liveness_authority");
    await f.sweep();
    expect(await f.effects()).toEqual(before);
  });

  it("keyset pages both sets to the limit without an open first page starving a later due connection", async () => {
    const connections = [{ connectionId: target.connectionId, token: f.h.token }];
    for (const connectionId of ["connection_liveness_a", "connection_liveness_z"]) {
      await f.h.connection(connectionId);
      await f.h.healthy(connectionId);
      connections.push({ connectionId, token: (await f.h.pair(connectionId)).token });
    }
    for (const options of connections) expect((await f.h.request("claim", {}, options)).status).toBe(200);
    for (let count = 0; count < connections.length; count++) expect((await f.sweep(undefined, 1)).accepted).toBe(1);
    expect(await f.observations()).toHaveLength(3);
    const stable = await f.effects();
    expect((await f.sweep(undefined, 1)).accepted).toBe(0);
    expect(await f.effects()).toEqual(stable);
    for (const options of connections) expect((await f.h.request("claim", {}, options)).status).toBe(200);
    for (let count = 0; count < connections.length; count++) expect((await f.sweep(undefined, 1)).accepted).toBe(1);
    expect(await f.observations()).toHaveLength(6);
  });
});
