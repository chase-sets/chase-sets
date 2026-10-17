import { expect, it, vi } from "vitest";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { connectorTransportPolicy, connectorPolicyDefaults } from "../domain/policy";
import { deriveServedPolicyIdentity } from "../domain/served-policy-identity";
import { describeDb, seller, target, transportContext, transportDatabase } from "./transport-test-support";

describeDb("connector-liveness-policy-identity", () => {
  const h = transportDatabase("connector_liveness_policy_7932");
  const read = () => h.services.connectorFeed.readConnectorLivenessAuthority({ connectionId: target.connectionId });
  it("real claim matches the pure snapshot and revises content in one row without metadata aliases", async () => {
    const documentId = await h.connectorPolicy(connectorPolicyDefaults);
    const routePolicyLookup = vi.spyOn(h.services.connectorFeed, "resolveTransportPolicy");
    expect((await h.request("claim")).status).toBe(200);
    expect(routePolicyLookup).not.toHaveBeenCalled();
    const first = await read();
    const resolver = createPolicyResolver({ db: h.db });
    const snapshot = await resolver.resolvePolicy(connectorTransportPolicy);
    expect(first?.servedPolicyIdentity).toBe(deriveServedPolicyIdentity(snapshot));
    const eventStore = createPostgresEventStore({ pool: h.db });
    const revised = await createPolicyRuntime({ eventStore, db: h.db }).revisePolicyDocument(
      connectorTransportPolicy,
      documentId,
      {
        status: "active",
        value: { ...connectorPolicyDefaults, pollWindowSeconds: 75 },
        effectiveFrom: snapshot.effectiveFrom!,
        effectiveUntil: snapshot.effectiveUntil,
        actorUserId: seller.userId,
      },
      transportContext,
    );
    const projector = h.services.projectors.find(
      (entry) => entry.projectionName === "platform-policy-document-projection",
    );
    if (!projector) throw new Error("missing-policy-projector");
    for (const event of await eventStore.readStream({
      streamId: `platform-policy.document-${documentId}`,
      fromVersion: revised.version,
    })) {
      await projector.handlers[event.eventType]?.(toTransportEvent(event));
    }
    expect(await read()).toEqual(first);
    vi.setSystemTime(new Date("2026-10-07T12:00:01Z"));
    const response = await h.request("claim");
    expect(await response.json()).toEqual({ reservation: null, pollWindowSeconds: 75 });
    const second = await read();
    const current = await createPolicyResolver({ db: h.db }).resolvePolicy(connectorTransportPolicy);
    expect(current.documentId).toBe(snapshot.documentId);
    expect(current.effectiveFrom).toBe(snapshot.effectiveFrom);
    expect(second).toMatchObject({
      heartbeatRevision: 2,
      servedPollWindowSeconds: 75,
      heartbeatDueAt: "2026-10-07T12:01:16.000Z",
      servedPolicyIdentity: deriveServedPolicyIdentity(current),
    });
    expect(second?.servedPolicyIdentity).not.toBe(first?.servedPolicyIdentity);
    expect((await h.db.query("SELECT connection_id FROM channel_connector_liveness_authority")).rows).toHaveLength(1);
  });
  it("policy changes during reservation cannot rewrite the already admitted snapshot", async () => {
    const snapshot = await createPolicyResolver({ db: h.db }).resolvePolicy(connectorTransportPolicy);
    vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations").mockImplementation(async () => {
      await h.connectorPolicy({ ...connectorPolicyDefaults, pollWindowSeconds: 30 });
      throw new Error("synthetic-reservation-failure");
    });
    expect((await h.request("claim")).status).toBe(503);
    expect(await read()).toMatchObject({
      heartbeatRevision: 1,
      servedPollWindowSeconds: 60,
      servedPolicyIdentity: deriveServedPolicyIdentity(snapshot),
      heartbeatDueAt: "2026-10-07T12:01:00.000Z",
    });
    const current = await createPolicyResolver({ db: h.db }).resolvePolicy(connectorTransportPolicy);
    expect(current.value.pollWindowSeconds).toBe(30);
    expect((await read())?.servedPolicyIdentity).not.toBe(deriveServedPolicyIdentity(current));
  });
});
