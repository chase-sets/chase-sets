import { expect, it } from "vitest";
import { describeDb, target, transportDatabase } from "./transport-test-support";
import {
  ageAdmission,
  drain,
  identityRows,
  orderInbound,
  orderObservationSweep,
  payloadIds,
  providerEventId,
} from "./retention-test-support";

describeDb("connector-inbound-expired-identity-inert", () => {
  const h = transportDatabase("connector_retention_inert_8592");

  it("keeps an expired identity, order, cursor, horizon and total, and a re-post stays inert without recreating the payload", async () => {
    const references = ["order.inert:0", "order.inert:1", "order.inert:2"];
    for (const reference of references) expect((await h.request("ingest", orderInbound(reference))).status).toBe(202);
    const [expiredId, ...freshIds] = references.map((reference) =>
      providerEventId(target.connectionId, orderInbound(reference)),
    );
    if (!expiredId) throw new Error("missing-fixture-identity");
    const read = (after?: string) =>
      h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
    for (const id of freshIds) await ageAdmission(h.db, id, 3_600);
    await ageAdmission(h.db, expiredId, 7_776_000 + 3_600);
    const firstPage = await read();
    if (!firstPage.nextCursor) throw new Error("missing-fixture-cursor");
    const identities = await identityRows(h.db);

    expect(await drain(h.db, orderObservationSweep)).toEqual([1]);
    expect(await payloadIds(h.db)).toEqual([...freshIds].sort());
    expect(await identityRows(h.db)).toEqual(identities);

    const expiredPage = await read();
    expect(expiredPage).toEqual({
      ...firstPage,
      events: firstPage.events.map((event) =>
        event.providerEventId === expiredId ? { ...event, content: { state: "expired" } } : event,
      ),
    });
    const secondPage = await read(firstPage.nextCursor);
    expect(secondPage.horizon).toBe(firstPage.horizon);
    expect(secondPage.completeness).toEqual({ kind: "complete", total: 3 });
    expect(secondPage.events.map((event) => [event.externalReference, event.content.state])).toEqual([
      ["order.inert:2", "available"],
    ]);

    for (const repost of [orderInbound("order.inert:0"), orderInbound("order.inert:0", { order: "changed" })]) {
      const response = await h.request("ingest", repost);
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("{}");
    }
    expect(await payloadIds(h.db)).toEqual([...freshIds].sort());
    expect(await identityRows(h.db)).toEqual(identities);
    expect(await read()).toEqual(expiredPage);

    // Delete-identity mutant: had retention removed the identity, the same re-post would
    // re-admit under a new sequence and recreate the payload, which the assertions above reject.
    await h.db.query("DELETE FROM channel_connector_inbound_events WHERE provider_event_id=$1", [expiredId]);
    expect((await h.request("ingest", orderInbound("order.inert:0"))).status).toBe(202);
    expect(await payloadIds(h.db)).toContain(expiredId);
    const readmitted = (
      await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
      })
    ).events.find((event) => event.providerEventId === expiredId);
    expect(readmitted?.sequence).not.toBe(firstPage.events[0]?.sequence);
    expect(readmitted?.content.state).toBe("available");
  });
});
