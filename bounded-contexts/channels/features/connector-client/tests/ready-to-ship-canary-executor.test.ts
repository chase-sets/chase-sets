import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { reserveReadyToShipCanary } from "../../outbound-sync/api/ready-to-ship-canary";
import { canarySalePullId, type CanaryHandoff } from "../../outbound-sync/domain/ready-to-ship-canary";
import { createReadyToShipCanaryExecutor } from "../domain/ready-to-ship-canary-executor";
import { coordinatorFixture } from "./coordinator-test-support";

describe("Ready to Ship canary executor", () => {
  it.each([
    ["at the default poll", connectorPolicyDefaults.pollWindowSeconds * 1000, "replayed"],
    ["just before expiry", 299_750, "replayed"],
    ["at expiry", 300_000, "expired"],
    ["after expiry", 300_001, "expired"],
    ["until the journal budget is exhausted", connectorPolicyDefaults.pollWindowSeconds * 1000, "exhausted"],
  ])("reconciles the sealed sale %s without a new lease", async (_label, delay, outcome) => {
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
        return Response.json({ reservation: claimed, pollWindowSeconds: connectorPolicyDefaults.pollWindowSeconds });
      }
      if (action === "ingest") {
        posts.push(bytes);
        if (posts.length === 1 || outcome === "exhausted") throw new Error("synthetic lost post response");
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
    f.setNow(Date.parse(handoff.finishedAt) + delay);
    const work = { ...f.input, reason: "work" } as const;
    if (outcome === "exhausted") {
      const postBudget = reservation!.operations[0]!.payload.bounds.maxObservationPosts;
      for (let prior = 1; prior <= postBudget; prior++) {
        expect(await f.coordinator().coordinate(work)).toMatchObject({ outcome: "unknown" });
        expect(posts).toEqual(Array(Math.min(prior + 1, postBudget)).fill(posts[0]));
      }
      expect(reports).toEqual([]);
      return;
    }
    expect(await f.coordinator().coordinate(work)).toMatchObject({ outcome: "ok" });
    expect(await f.coordinator().coordinate(work)).toMatchObject({ outcome: "ok" });
    expect(posts).toEqual(outcome === "replayed" ? [posts[0], posts[0]] : [posts[0]]);
    expect(reports).toHaveLength(outcome === "replayed" ? 1 : 0);
    if (outcome === "replayed") expect(JSON.parse(reports[0]!).outcomes[0].outcome).toEqual({ kind: "canary-posted" });
  });
});
