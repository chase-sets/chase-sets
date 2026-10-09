import { describe, expect, it, vi } from "vitest";
import type { ConnectorExecutor } from "../domain/operation-protocol";
import { pullFixture } from "./connector-order-pull-test-support";
import {
  composeChannelOrderFulfillmentInbound,
  fulfillmentObservationDigest,
  type ChannelOrderFulfillmentObservation,
} from "../../order-fulfillment-observations/domain/contracts";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { reconstructFulfillmentPost } from "../domain/order-pull-handoff";

describe("connector-order-pull-admission-crash-matrix", () => {
  it("applies the same digest, reference and status reread law to status-only observations", async () => {
    const observation: ChannelOrderFulfillmentObservation = {
      version: 1,
      variant: "status-only",
      providerKey: "tcgplayer",
      externalOrderReference: "SYNTHETIC-FOLLOW-UP",
      providerOrderStatus: { surface: "detail", value: "Ready to Ship" },
      revision: "synthetic-revision",
    };
    const inbound = await composeChannelOrderFulfillmentInbound(observation);
    const post = {
      kind: "fulfillment" as const,
      variant: "status-only" as const,
      state: "dispatched" as const,
      externalReference: inbound.externalReference,
      digest: await fulfillmentObservationDigest(observation),
      status: observation.providerOrderStatus,
    };
    expect(await reconstructFulfillmentPost(observation.externalOrderReference, post, observation)).toBe(
      canonicalJson(inbound),
    );
    expect(
      await reconstructFulfillmentPost(observation.externalOrderReference, post, {
        ...observation,
        revision: "changed",
      }),
    ).toBeNull();
    expect(await reconstructFulfillmentPost("SYNTHETIC-OTHER", post, observation)).toBeNull();
    expect(
      await reconstructFulfillmentPost(
        observation.externalOrderReference,
        { ...post, status: { surface: "list", value: "Ready to Ship" } },
        observation,
      ),
    ).toBeNull();
  });
  it.each([
    "detail",
    "partial-bundle",
    "handoff",
    "post-loss",
    "202-captured",
    "summary-captured",
    "report-loss",
    "acked",
  ])("retains the six-state law across %s", async (cut) => {
    const f = await pullFixture();
    const request = f.request.getMockImplementation()!;
    if (cut === "report-loss")
      f.request.mockImplementation(async (r) => {
        const response = await request(r);
        if (new URL(r.url).pathname.endsWith("/report")) throw new Error("synthetic report loss");
        return response;
      });
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      if (cut === "detail") throw new Error("synthetic crash after detail before handoff");
      await pull!.save(
        cut === "partial-bundle" ? { ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: null }] } : f.handoff,
      );
      if (["handoff", "partial-bundle"].includes(cut)) throw new Error("synthetic crash after handoff");
      await pull!.sale("SYNTHETIC-ORDER-1", 0, async (bytes, signal) => {
        const response = await f.post(bytes, signal);
        if (cut === "post-loss") throw new Error("synthetic sale response loss");
        return response;
      });
      if (cut === "202-captured") throw new Error("synthetic crash after capture");
      await pull!.sale(null, 0, f.post);
      if (cut === "summary-captured") throw new Error("synthetic crash after summary");
      return pull!.result();
    });
    await f.coordinator().coordinate(f.input);
    const before = await f.journal.read(f.input.connectionId);
    expect(before.members).toHaveLength(1);
    const reconcile: NonNullable<ConnectorExecutor["reconcileAmbiguous"]> = async (_u, pull) => {
      if (["detail", "partial-bundle"].includes(cut)) return pull!.result("completeness-unproven");
      await pull!.sale("SYNTHETIC-ORDER-1", 0, f.post);
      await pull!.sale(null, 0, f.post);
      return pull!.result();
    };
    f.ports.executors = [{ ...f.executor, reconcileAmbiguous: reconcile }];
    f.request.mockImplementation(request);
    await f.coordinator().coordinate(f.input);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
    if (cut === "post-loss") expect(f.posts[0]).toBe(f.posts[1]);
    if (["202-captured", "summary-captured", "report-loss", "acked"].includes(cut)) expect(f.posts).toHaveLength(2);
    if (["detail", "partial-bundle"].includes(cut)) expect(f.posts).toEqual([]);
    if (cut === "report-loss") expect(new Set(f.reports).size).toBe(1);
    const retained = JSON.stringify(await f.journal.read(f.input.connectionId));
    expect(retained).not.toContain("synthetic crash");
  });
  it.each([false, true])("recovers fulfillment by member reread, changed=%s", async (changed) => {
    const f = await pullFixture();
    const observation: ChannelOrderFulfillmentObservation = {
      version: 1,
      variant: "full",
      providerKey: "tcgplayer",
      externalOrderReference: "SYNTHETIC-ORDER-1",
      providerOrderStatus: { surface: "detail", value: "Ready to Ship" },
      orderedAt: "2026-10-09T00:00:00.000Z",
      providerShippingType: { surface: "detail", value: "Standard (7-10 days)" },
      shipTo: {
        name: "SYNTHETIC_PII_SENTINEL",
        line1: "SYNTHETIC_ADDRESS",
        city: "X",
        state: "X",
        postalCode: "X",
        country: "US",
      },
      lines: [
        {
          productId: "1",
          skuId: "2",
          providerOrderLineIdentity: "synthetic-line",
          quantity: 1,
          unitPriceAmount: "1.00",
        },
      ],
      productAmount: "1.00",
      shippingAmount: "1.00",
      currency: { code: "USD", provenance: "tcgplayer-constant" },
    };
    const inbound = await composeChannelOrderFulfillmentInbound(observation);
    const descriptor = {
      kind: "fulfillment" as const,
      externalReference: inbound.externalReference,
      digest: await fulfillmentObservationDigest(observation),
      variant: observation.variant,
      status: observation.providerOrderStatus,
      state: "planned" as const,
    };
    f.dispatch.mockImplementation(async (_u, _s, pull) => {
      await pull!.save({ ...f.handoff, bundles: [{ ...f.handoff.bundles[0], posts: [descriptor] }] });
      await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, observation, async (bytes) => {
        f.posts.push(bytes);
        throw new Error("synthetic fulfillment response loss");
      });
      return pull!.result();
    });
    await f.coordinator().coordinate(f.input);
    const reread = vi.fn(async () => (changed ? { ...observation, shippingAmount: "2.00" } : observation));
    f.ports.executors = [
      {
        ...f.executor,
        reconcileAmbiguous: async (_u, pull) => {
          await pull!.fulfillment("SYNTHETIC-ORDER-1", 0, reread, f.post);
          if (!changed) await pull!.sale(null, 0, f.post);
          return pull!.result();
        },
      },
    ];
    await f.coordinator().coordinate(f.input);
    expect(reread).toHaveBeenCalledTimes(1);
    if (changed) {
      expect(f.posts).toHaveLength(1);
      expect(JSON.parse(f.reports[0]).outcomes[0].outcome).toEqual({
        kind: "order-pull-unknown",
        reason: "recovery-content-changed",
      });
    } else {
      expect(f.posts[0]).toBe(canonicalJson(inbound));
      expect(f.posts[1]).toBe(f.posts[0]);
    }
    const retained = JSON.stringify(await f.journal.read(f.input.connectionId));
    expect(retained).not.toContain("SYNTHETIC_PII_SENTINEL");
    expect(retained).not.toContain("SYNTHETIC_ADDRESS");
    expect(f.reports.join()).not.toContain("shipTo");
  });
});
