import { expect, it } from "vitest";
import { describeDb, seller, target, transportDatabase } from "./transport-test-support";

describeDb("connector-liveness-candidates", () => {
  const h = transportDatabase("connector_liveness_candidates_7932");
  const list = (dueAt: string, limit = 100) =>
    h.services.connectorFeed.listConnectorLivenessCandidates({ dueAt, limit });
  it("excludes no-poll, unpaired and non-active rows; includes the exact due boundary", async () => {
    expect((await list("2026-10-07T12:01:00Z")).candidates).toEqual([]);
    await h.request("claim");
    expect((await list("2026-10-07T12:00:59.999Z")).candidates).toEqual([]);
    expect((await list("2026-10-07T12:01:00Z")).candidates).toEqual([
      await h.services.connectorFeed.readConnectorLivenessAuthority({ connectionId: target.connectionId }),
    ]);
    await h.pause();
    expect((await list("2026-10-07T12:01:00Z")).candidates).toEqual([]);
    await h.services.connectorFeed.unpair(target, h.pairingId, 2, seller);
    expect((await list("2026-10-07T12:01:00Z")).candidates).toEqual([]);
  });
  it("paginates tied due times without duplicates or omissions", async () => {
    await h.request("claim");
    for (const connectionId of ["connection_page_a", "connection_page_b"]) {
      await h.connection(connectionId);
      await h.healthy(connectionId);
      const paired = await h.pair(connectionId);
      expect((await h.request("claim", {}, { connectionId, token: paired.token })).status).toBe(200);
    }
    const first = await list("2026-10-07T12:01:00Z", 2);
    expect(first.candidates).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.services.connectorFeed.listConnectorLivenessCandidates({
      dueAt: "2026-10-07T12:01:00Z",
      limit: 2,
      after: first.nextCursor!,
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.candidates, ...second.candidates].map((row) => row.connectionId)).toEqual([
      "connection_page_a",
      "connection_page_b",
      target.connectionId,
    ]);
  });
});
