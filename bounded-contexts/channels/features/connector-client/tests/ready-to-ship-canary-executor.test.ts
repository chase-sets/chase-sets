import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { reserveReadyToShipCanary } from "../../outbound-sync/api/ready-to-ship-canary";
import { canarySalePullId, type CanaryHandoff } from "../../outbound-sync/domain/ready-to-ship-canary";
import { createReadyToShipCanaryExecutor } from "../domain/ready-to-ship-canary-executor";
import { coordinatorFixture } from "./coordinator-test-support";

describe("Ready to Ship canary executor", () => {
  it.each([false, true])("posts only the sealed sale, with one lease (expired: %s)", async (expired) => {
    const f = await coordinatorFixture();
    const target = { connectionId: f.input.connectionId, pairingId: f.claim.claimant.claimantId };
    const pageClaim = "00000000-0000-4000-8000-000000000055";
    const handoff: CanaryHandoff = {
      pageClaim,
      target,
      sealDigest: "a".repeat(64),
      finishedAt: new Date(f.now()).toISOString(),
      expiresAt: new Date(f.now() + 300_000).toISOString(),
      sales: [
        {
          version: 1,
          kind: "order",
          pullId: canarySalePullId(pageClaim),
          orderNumber: "SYNTHETIC-ORDER",
          soldAt: new Date(f.now()).toISOString(),
          cancelled: false,
          lines: [{ productId: "1", skuId: "2", quantity: 1, unitPriceAmount: "1.00" }],
        },
      ],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ handoff }] })
      .mockResolvedValueOnce({ rows: [{ page_claim: pageClaim }] });
    const reservation = await reserveReadyToShipCanary({ query } satisfies PgQueryable, {
      connectionId: target.connectionId,
      claimant: f.claim.claimant,
      grantId: "synthetic-grant",
      providerIdentity: f.claim.providerIdentity,
      reservedAt: handoff.finishedAt,
      leaseExpiresAt: new Date(f.now() + 1_800_000).toISOString(),
    });
    expect(reservation).toMatchObject({ leaseExpiresAt: handoff.expiresAt });
    f.ports.executors = [createReadyToShipCanaryExecutor()];
    const posts: string[] = [];
    const reports: string[] = [];
    let offered = false;
    f.request.mockImplementation(async (request) => {
      expect(new URL(request.url).origin).toBe("https://synthetic.invalid");
      const bytes = await request.text();
      const action = new URL(request.url).pathname.split("/").at(-1);
      if (action === "claim") {
        expect(JSON.parse(bytes)).toEqual({ readyToShipCanary: true });
        const claimed = offered ? null : reservation;
        offered = true;
        return Response.json({ reservation: claimed, pollWindowSeconds: 60 });
      }
      if (action === "ingest") {
        posts.push(bytes);
        if (posts.length === 1) throw new Error("synthetic lost post response");
        return new Response("{}", { status: 202 });
      }
      expect(action).toBe("report");
      reports.push(bytes);
      return new Response("{}", { status: 200 });
    });
    expect(await f.coordinator().coordinate(f.input)).toMatchObject({ outcome: "unknown" });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({
      canaryReservationId: reservation?.reservationId,
      payload: { records: handoff.sales },
    });
    expect((await f.journal.read(f.input.connectionId)).members[0]).toMatchObject({
      handoff: { usage: { providerCalls: 0, posts: 1 } },
    });
    if (expired) f.setNow(Date.parse(handoff.expiresAt));
    expect(await f.coordinator().coordinate(f.input)).toMatchObject({ outcome: "ok" });
    expect(posts).toEqual(expired ? [posts[0]] : [posts[0], posts[0]]);
    expect(reports).toHaveLength(expired ? 0 : 1);
    if (!expired) expect(JSON.parse(reports[0]!).outcomes[0].outcome).toEqual({ kind: "canary-posted" });
  });
});
