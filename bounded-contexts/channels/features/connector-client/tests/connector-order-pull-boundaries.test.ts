import { describe, expect, it, vi } from "vitest";
import { pullFixture } from "./connector-order-pull-test-support";
import { syntheticPage } from "../../outbound-sync/tests/order-pull-fixtures";
import {
  browserPayloadDigest,
  parseExecutorResult,
  parseOperationAttempt,
  parseOperationReservation,
} from "../domain/operation-protocol";
import { parseOrderPullHandoff, orderPullReportOutcome } from "../domain/order-pull-handoff";
import { assertClaimedOrderPullOutcome } from "../../outbound-sync/domain/order-pull-codec";
import { orderPullCheckpointDigest } from "../../outbound-sync/domain/order-pull-progress";
import { orderPullProgressByteLimit } from "../../outbound-sync/domain/order-pull-progress-codec";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import {
  composeChannelOrderFulfillmentInbound,
  fulfillmentObservationDigest,
  type ChannelOrderFulfillmentObservation,
  acceptedReadyToShipInputByteLimit,
} from "../../order-fulfillment-observations/domain/contracts";

const byteLength = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).length;

const observation: ChannelOrderFulfillmentObservation = {
  version: 1,
  variant: "full",
  providerKey: "tcgplayer",
  externalOrderReference: "SYNTHETIC-ORDER-1",
  providerOrderStatus: { surface: "detail", value: "Ready to Ship" },
  orderedAt: "2026-10-09T00:00:00.000Z",
  providerShippingType: { surface: "detail", value: "Standard (7-10 days)" },
  shipTo: { name: "SYNTHETIC", line1: "SYNTHETIC", city: "X", state: "X", postalCode: "X", country: "US" },
  lines: [
    { productId: "1", skuId: "2", providerOrderLineIdentity: "synthetic-line", quantity: 1, unitPriceAmount: "1.00" },
  ],
  productAmount: "1.00",
  shippingAmount: "1.00",
  currency: { code: "USD", provenance: "tcgplayer-constant" },
};

async function fulfillmentDescriptor() {
  const inbound = await composeChannelOrderFulfillmentInbound(observation);
  return {
    kind: "fulfillment" as const,
    externalReference: inbound.externalReference,
    digest: await fulfillmentObservationDigest(observation),
    variant: observation.variant,
    status: observation.providerOrderStatus,
    state: "planned" as const,
  };
}

describe("connector-order-pull-boundaries", () => {
  it("F1: a valid full-page continuation reaches the report boundary", async () => {
    const f = await pullFixture();
    const references = Array.from({ length: 100 }, (_, i) => `SYNTHETIC-${i}-${"\u4e00".repeat(90)}`);
    const handoff = {
      ...f.handoff,
      bundles: [],
      summary: null,
      progress: {
        ...f.handoff.progress,
        pages: [syntheticPage(references, { nextCursor: "synthetic-next", totalOrders: null })],
      },
    };
    expect(() => parseOrderPullHandoff(handoff, f.payload)).not.toThrow();
    const outcome = {
      operationKind: "tcgplayer-order-pull" as const,
      operationId: f.claim.operations[0].operationId,
      attemptId: f.claim.operations[0].attemptId,
      claimGeneration: 1,
      pullId: f.payload.pullId,
      payloadDigest: f.claim.operations[0].payloadDigest,
      outcome: orderPullReportOutcome(f.payload, handoff),
    };
    expect(outcome.outcome.kind).toBe("continuation-required");
    expect(() => assertClaimedOrderPullOutcome(outcome)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(outcome)).length).toBeGreaterThan(16384);
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(handoff);
      return pull!.result();
    });
    await f.coordinator().coordinate(f.input);
    expect(f.reports).toHaveLength(1);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
    expect(() => parseExecutorResult({ outcomes: [outcome] })).not.toThrow();
  });

  it("F2: same-job fulfillment retry refuses before a provider reread", async () => {
    const f = await pullFixture();
    const descriptor = await fulfillmentDescriptor();
    const reread = vi.fn(async () => observation);
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save({ ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: [descriptor] }] });
      await expect(
        pull!.fulfillment("SYNTHETIC-ORDER-1", 0, observation, async () => {
          throw new Error("synthetic lost response");
        }),
      ).rejects.toThrow("synthetic lost response");
      await expect(pull!.fulfillment("SYNTHETIC-ORDER-1", 0, reread, f.post)).rejects.toThrow("stale-fence");
      return pull!.result("admission-ambiguous");
    });
    await f.coordinator().coordinate(f.input);
    expect(reread).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["read-failure", "changed-content"])(
    "F2: %s consumes the fresh recovery job's single attempt",
    async (fault) => {
      const f = await pullFixture();
      const descriptor = await fulfillmentDescriptor();
      f.dispatch.mockImplementation(async (_u, _s, pull) => {
        await pull!.save({ ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: [descriptor] }] });
        await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, observation, async () => {
          throw new Error("synthetic lost response");
        });
        return pull!.result();
      });
      await f.coordinator().coordinate(f.input);
      const reread = vi.fn(async () => {
        if (fault === "read-failure") throw new Error("synthetic read failure");
        return { ...observation, shippingAmount: "2.00" };
      });
      const secondRead = vi.fn(async () => observation);
      const refused = vi.fn();
      f.ports.executors = [
        {
          ...f.executor,
          reconcileAmbiguous: async (_u, pull) => {
            await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, reread, f.post);
            // Cadence has elapsed, so it cannot mask a missing execution-local attempt fence.
            f.setNow(f.now() + f.handoff.authority.providerCadenceMs);
            await expect(pull!.fulfillment("SYNTHETIC-ORDER-1", 0, secondRead, f.post)).rejects.toThrow("stale-fence");
            refused();
            return pull!.result();
          },
        },
      ];
      await f.coordinator().coordinate(f.input);
      expect(refused).toHaveBeenCalledOnce();
      expect(reread).toHaveBeenCalledOnce();
      expect(secondRead).not.toHaveBeenCalled();
      expect(f.post).not.toHaveBeenCalled();
      expect(JSON.parse(f.reports[0]).outcomes[0].outcome).toEqual({
        kind: "order-pull-unknown",
        reason: "recovery-content-changed",
      });
      const member = (await f.journal.read(f.input.connectionId)).members[0];
      if (member.operationKind !== "tcgplayer-order-pull") throw new Error("fixture drift");
      expect(member.handoff?.usage).toMatchObject({ providerCalls: 1, posts: 1 });
    },
  );

  it("F2: captured fulfillment skips immediately even after its attempt was claimed", async () => {
    const f = await pullFixture();
    const descriptor = await fulfillmentDescriptor();
    const reread = vi.fn(async () => observation);
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save({ ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: [descriptor] }] });
      await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, observation, f.post);
      await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, reread, f.post);
      await pull!.sale(null, 0, f.post);
      return pull!.result();
    });
    await f.coordinator().coordinate(f.input);
    expect(reread).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
  });

  it("F1: maximum-byte full pages survive receipt capture, report loss and byte-identical replay", async () => {
    const f = await pullFixture();
    const selector = { ...f.payload.selector, pageSize: 1000 };
    const checkpoint = { ...f.payload.checkpoint, selector };
    const payload = { ...f.payload, selector, checkpoint, checkpointDigest: orderPullCheckpointDigest(checkpoint) };
    f.claims[0] = {
      ...f.claim,
      operations: [{ ...f.claim.operations[0], payload, payloadDigest: await browserPayloadDigest(payload) }],
    };
    const pages = [0, 1].map((page) => {
      const references = Array.from(
        { length: 1000 },
        (_, i) => `SYNTHETIC-${page}-${String(i).padStart(4, "0")}-${"\u4e00".repeat(79)}`,
      );
      let remaining =
        acceptedReadyToShipInputByteLimit -
        byteLength({ connectionId: payload.connectionId, orderReferences: references });
      for (let i = 0; remaining > 0; i++) {
        const padding = Math.min(128 - references[i].length, remaining);
        references[i] += "x".repeat(padding);
        remaining -= padding;
      }
      expect(byteLength({ connectionId: payload.connectionId, orderReferences: references })).toBe(
        acceptedReadyToShipInputByteLimit,
      );
      return syntheticPage(references, {
        cursor: page === 0 ? null : "synthetic-next-1",
        nextCursor: `synthetic-next-${page + 1}`,
        totalOrders: null,
      });
    });
    const handoff = {
      ...f.handoff,
      authority: { ...f.handoff.authority, selector },
      bundles: [],
      summary: null,
      progress: { ...f.handoff.progress, previousDigest: payload.checkpointDigest, pages },
    };
    expect(() => parseOrderPullHandoff(handoff, payload)).not.toThrow();
    // The last reference still has scalar capacity; only the complete request byte cap is crossed.
    const over = {
      ...handoff,
      progress: {
        ...handoff.progress,
        pages: [
          { ...pages[0], orderReferences: pages[0].orderReferences.map((ref, i) => (i === 999 ? `${ref}x` : ref)) },
          pages[1],
        ],
      },
    };
    expect(() => parseOrderPullHandoff(over, payload)).toThrow();
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save(handoff);
      return pull!.result();
    });
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (r) => {
      const response = await request(r);
      if (new URL(r.url).pathname.endsWith("/report")) throw new Error("synthetic report loss");
      return response;
    });
    await f.coordinator().coordinate(f.input);
    const saved = await f.journal.read(f.input.connectionId);
    expect(saved.members[0].state).toBe("reported");
    expect(byteLength(saved.members[0].receipt)).toBeGreaterThan(2 * acceptedReadyToShipInputByteLimit);
    expect(parseOperationAttempt(saved.members[0]).receipt).toEqual(saved.members[0].receipt);
    expect(parseOperationReservation(saved.reservations[0]).reportEnvelope).toEqual(
      saved.reservations[0].reportEnvelope,
    );
    expect(saved.members[0].receipt?.outcomes[0].outcome.kind).toBe("continuation-required");
    f.request.mockImplementation(request);
    await f.coordinator().coordinate(f.input);
    expect(f.reports).toHaveLength(2);
    expect(f.reports[1]).toBe(f.reports[0]);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
  });

  it("F1: the producer progress byte ceiling and ceiling-plus-one apply to outcome, receipt and report parsers", async () => {
    const f = await pullFixture();
    await f.coordinator().coordinate(f.input);
    const saved = await f.journal.read(f.input.connectionId);
    const references = Array.from(
      { length: 1000 },
      (_, i) => `SYNTHETIC-${String(i).padStart(4, "0")}-${"\u4e00".repeat(79)}`,
    );
    const progress = {
      ...f.handoff.progress,
      pages: [syntheticPage(references), syntheticPage(references)],
      postedReferences: references,
      gaps: Array.from({ length: 1000 }, (_, i) => ({
        reference: `SYNTHETIC-GAP-${i}-`,
        reason: "unavailable" as const,
      })),
    };
    let remaining = orderPullProgressByteLimit - byteLength(progress);
    for (const gap of progress.gaps) {
      const count = Math.min(127 - gap.reference.length, Math.floor(remaining / 3));
      gap.reference += "\u4e00".repeat(count);
      remaining -= count * 3;
    }
    expect(remaining).toBeLessThan(3);
    progress.gaps[999].reference += "x".repeat(remaining);
    expect(byteLength(progress)).toBe(orderPullProgressByteLimit);
    const result = structuredClone(saved.members[0].receipt!);
    const pullOutcome = result.outcomes[0];
    if (!("operationKind" in pullOutcome) || !("progress" in pullOutcome.outcome)) throw new Error("fixture drift");
    const boundary = { ...pullOutcome, outcome: { ...pullOutcome.outcome, progress } };
    expect(() => assertClaimedOrderPullOutcome(boundary)).not.toThrow();
    const receipt = { outcomes: [boundary] };
    const reportEnvelope = { reservationId: saved.reservations[0].reservationId, ...receipt };
    expect(parseExecutorResult(receipt)).toEqual(receipt);
    expect(parseOperationAttempt({ ...saved.members[0], receipt }).receipt).toEqual(receipt);
    expect(parseOperationReservation({ ...saved.reservations[0], reportEnvelope }).reportEnvelope).toEqual(
      reportEnvelope,
    );
    progress.gaps[999].reference += "x";
    expect(byteLength(progress)).toBe(orderPullProgressByteLimit + 1);
    expect(() => parseExecutorResult(receipt)).toThrow();
    expect(() => parseOperationAttempt({ ...saved.members[0], receipt })).toThrow();
    expect(() => parseOperationReservation({ ...saved.reservations[0], reportEnvelope })).toThrow();
  });
});
