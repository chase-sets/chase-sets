import { describe, expect, it } from "vitest";
import { assertOrderPullCheckpoint, orderPullCheckpointDigest } from "../../outbound-sync/domain/order-pull-progress";
import { syntheticPage } from "../../outbound-sync/tests/order-pull-fixtures";
import {
  browserCheckpointDigest,
  orderPullHandoffOutcome,
  orderPullReportOutcome,
  parseOrderPullHandoff,
} from "../domain/order-pull-handoff";
import { resolveOrderPullBudget } from "../../outbound-sync/domain/order-pull-codec";
import { pullFixture } from "./connector-order-pull-test-support";

describe("connector-order-pull-post-before-report", () => {
  it("completes a qualified empty page without inventing a summary post outside a zero-post allocation", async () => {
    const f = await pullFixture();
    const budget = resolveOrderPullBudget(f.handoff.authority, { listReads: 1, intakeReads: 0, followUpReads: 0 });
    if (budget.kind !== "fits") throw new Error("fixture drift");
    const payload = { ...f.payload, bounds: budget.bounds };
    const handoff = {
      ...f.handoff,
      bundles: [],
      summary: null,
      progress: { ...f.handoff.progress, pages: [syntheticPage([], { totalOrders: null })] },
    };
    expect(orderPullReportOutcome(payload, handoff).kind).toBe("order-pull-complete");
    expect(f.posts).toEqual([]);
  });
  it("will not dispatch a partial bundle or retry a post within the same job", async () => {
    const f = await pullFixture();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save({ ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: null }] });
      await expect(pull!.sale("SYNTHETIC-ORDER-1", 0, f.post)).rejects.toThrow();
      expect(f.posts).toEqual([]);
      await pull!.save(f.handoff);
      const lost = async (bytes: string) => {
        f.posts.push(bytes);
        throw new Error("synthetic response loss");
      };
      await expect(pull!.sale("SYNTHETIC-ORDER-1", 0, lost)).rejects.toThrow("synthetic response loss");
      await expect(pull!.sale("SYNTHETIC-ORDER-1", 0, f.post)).rejects.toThrow("stale-fence");
      return pull!.result("admission-ambiguous");
    });
    await f.coordinator().coordinate(f.input);
    expect(f.posts).toHaveLength(1);
    expect(f.post).not.toHaveBeenCalled();
  });
  it("captures admissions before reporting pending, never treats a 202 as acceptance, and replays identical report bytes", async () => {
    const f = await pullFixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (r) => {
      if (new URL(r.url).pathname.endsWith("/report")) {
        expect(f.posts).toHaveLength(2);
        f.reports.push(await r.text());
        throw new Error("synthetic response loss");
      }
      return request(r);
    });
    await f.coordinator().coordinate(f.input);
    const saved = await f.journal.read(f.input.connectionId);
    expect(saved.reservations[0].reportEnvelope?.outcomes[0].outcome.kind).toBe("order-pull-pending");
    await f.coordinator().coordinate(f.input);
    expect(new Set(f.reports).size).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it("refuses a report before the bundle and summary are admitted", async () => {
    const f = await pullFixture();
    expect(() => orderPullHandoffOutcome(f.payload, f.handoff)).toThrow();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(f.handoff);
      return pull!.result();
    });
    await f.coordinator().coordinate(f.input);
    expect(f.reports).toEqual([]);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("outcome-unknown");
  });
  it.each(["full-page", "unread", "pending", "accepted", "gap", "null-total", "follow-up-tail"])(
    "classifies the v2 %s control with owner acceptance distinct from admission",
    async (control) => {
      const f = await pullFixture();
      let payload = f.payload;
      let progress = f.handoff.progress;
      if (control === "full-page")
        progress = {
          ...progress,
          pages: [
            syntheticPage(
              Array.from({ length: 100 }, (_, i) => `SYNTHETIC-${i}`),
              { nextCursor: "synthetic-next", totalOrders: 100 },
            ),
          ],
        };
      if (control === "null-total") progress = { ...progress, pages: [syntheticPage([], { totalOrders: null })] };
      if (control === "follow-up-tail") progress = { ...progress, pages: [syntheticPage([])], followUpTail: true };
      if (control === "accepted" || control === "pending") {
        const checkpoint = {
          ...payload.checkpoint,
          traversal: {
            sessionDigest: "a".repeat(64),
            frontier: "synthetic-frontier",
            nextCursor: null,
            totalOrders: 1,
            discovered: 1,
            pages: 1,
            exhausted: true,
          },
        };
        payload = {
          ...payload,
          checkpoint,
          checkpointDigest: orderPullCheckpointDigest(checkpoint),
          work: {
            chunkId: 1,
            references: ["SYNTHETIC-ORDER-1"],
            postedReferences: ["SYNTHETIC-ORDER-1"],
            acceptedReferences: control === "accepted" ? ["SYNTHETIC-ORDER-1"] : [],
          },
        };
        progress = { ...progress, previousDigest: payload.checkpointDigest, pages: [] };
      }
      if (control === "gap")
        progress = { ...progress, gaps: [{ reference: "SYNTHETIC-ORDER-1", reason: "unmappable" }] };
      const handoff = {
        ...f.handoff,
        progress,
        bundles: [],
        summary: { ...f.handoff.summary!, state: "captured202" as const },
      };
      const expected = {
        "full-page": "continuation-required",
        unread: "continuation-required",
        pending: "order-pull-pending",
        accepted: "order-pull-complete",
        gap: "order-pull-gaps",
        "null-total": "order-pull-complete",
        "follow-up-tail": "continuation-required",
      };
      expect(orderPullHandoffOutcome(payload, handoff).kind).toBe(expected[control as keyof typeof expected]);
      if (control === "accepted") {
        // Another retained chunk can still be pending; only the server's settlement reader can close the burst.
        expect(orderPullReportOutcome(payload, handoff).kind).toBe("order-pull-pending");
      }
    },
  );
  it.each(["unsafe-cursor", "drift", "total-mismatch"])("refuses %s rather than reporting complete", async (fault) => {
    const f = await pullFixture();
    let pages = f.handoff.progress.pages;
    if (fault === "unsafe-cursor") pages = [syntheticPage(["SYNTHETIC-ORDER-1"], { cursor: "wrong" })];
    if (fault === "drift")
      pages = [
        syntheticPage(["SYNTHETIC-ORDER-1"], { nextCursor: "next", totalOrders: 2 }),
        syntheticPage(["SYNTHETIC-ORDER-2"], { cursor: "next", totalOrders: 2, frontier: "drift" }),
      ];
    if (fault === "total-mismatch") pages = [syntheticPage(["SYNTHETIC-ORDER-1"], { totalOrders: 2 })];
    const handoff = { ...f.handoff, progress: { ...f.handoff.progress, pages } };
    expect(() => parseOrderPullHandoff(handoff, f.payload)).toThrow();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      try {
        await pull!.save(handoff);
      } catch {
        return pull!.result("completeness-unproven");
      }
      throw new Error("invalid traversal accepted");
    });
    await f.coordinator().coordinate(f.input);
    expect(JSON.parse(f.reports[0]).outcomes[0].outcome).toEqual({
      kind: "order-pull-unknown",
      reason: "completeness-unproven",
    });
    expect(f.posts).toEqual([]);
  });
  it("uses producer canonicalization for a largest-count checkpoint and refuses oversized allocation before effects", async () => {
    const f = await pullFixture();
    const checkpoint = {
      ...f.payload.checkpoint,
      policyRevision: Number.MAX_SAFE_INTEGER,
      gapCount: Number.MAX_SAFE_INTEGER,
      selector: { ...f.payload.selector, identity: "a".repeat(128), version: Number.MAX_SAFE_INTEGER, pageSize: 1000 },
      traversal: {
        sessionDigest: "a".repeat(64),
        frontier: "x".repeat(512),
        nextCursor: "y".repeat(512),
        totalOrders: Number.MAX_SAFE_INTEGER,
        discovered: Number.MAX_SAFE_INTEGER - 1,
        pages: Number.MAX_SAFE_INTEGER,
        exhausted: false,
      },
    };
    assertOrderPullCheckpoint(checkpoint);
    expect(await browserCheckpointDigest({ ...f.payload, checkpoint })).toBe(orderPullCheckpointDigest(checkpoint));
    f.claims[0] = {
      ...f.claim,
      operations: [
        { ...f.claim.operations[0], payload: { ...f.payload, bounds: { ...f.payload.bounds, budgetMs: 600001 } } },
      ],
    };
    await f.coordinator().coordinate(f.input);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.posts).toEqual([]);
  });
});
