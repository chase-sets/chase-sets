import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertTcgplayerOrderRecord,
  ambiguousLineIndexes,
  composeTcgplayerOrderInbound,
  pullSummaryGap,
  tcgplayerSaleKey,
  type TcgplayerOrderObservation,
  type TcgplayerPullSummary,
} from "../domain/contracts";
import { composeTcgplayerOrderObservation } from "../domain/detail";

// Synthetic IDs; field names derive from #7793 comment 5647341461, not a live paired export.
export const syntheticOrder: TcgplayerOrderObservation = {
  version: 1,
  kind: "order",
  pullId: "synthetic-pull",
  orderNumber: "synthetic-order",
  soldAt: "2026-09-12T16:56:27.225Z",
  cancelled: false,
  lines: [{ productId: "202", skuId: "101", quantity: 2, unitPriceAmount: "10.00" }],
};
const summary: TcgplayerPullSummary = {
  version: 1,
  kind: "summary",
  pullId: "synthetic-pull",
  totalOrders: 1,
  pages: [{ offset: 0, count: 1, totalOrders: 1 }],
  range: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
  filter: "all",
  completion: "complete",
  unknownReason: null,
};

describe("tcgplayer-order-completeness closed handoff", () => {
  it("selects captured detail lines and never derives quantities or money from totals", () => {
    const mapped = composeTcgplayerOrderObservation("synthetic-pull", {
      createdAt: syntheticOrder.soldAt,
      orderNumber: syntheticOrder.orderNumber,
      status: "Ready to Ship",
      buyerName: "synthetic private name",
      shippingAddress: { recipientName: "private" },
      transaction: { productAmount: 999 },
      products: [{ productId: "0202", skuId: "0101", quantity: 2, unitPrice: 10, name: "unused" }],
    });
    expect(mapped).toEqual(syntheticOrder);
    expect(JSON.stringify(mapped)).not.toMatch(/private|buyer|shipping|transaction/);
  });
  it("pins immutable Inventory JSON identities separately from transport digests", async () => {
    expect(tcgplayerSaleKey("account", "connection", syntheticOrder.orderNumber, syntheticOrder.lines[0]!)).toEqual({
      version: "v1",
      providerKey: "tcgplayer",
      sellerEnvironmentLineage: '["tcgplayer-connector/v1","account","connection"]',
      orderLineIdentity: '["tcgplayer-order-line/v1","synthetic-order","202","101"]',
    });
    const first = await composeTcgplayerOrderInbound(syntheticOrder);
    expect(first.externalReference).toBe("tcgo.v1:a67334f7e0279d72351fe83939a9a3aeeef4248e185fb4def8d7edd1ba6d7e59");
    expect((await composeTcgplayerOrderInbound(summary)).externalReference).toBe(
      "tcgp.v1:0c8bd4b8adfda8f992f1ca0e7668391d8c796095c87d231c06afe4d7bc24c3d8",
    );
    expect(first.externalReference).toMatch(/^tcgo\.v1:[a-f0-9]{64}$/);
    expect(first.externalReference).toHaveLength(72);
    expect((await composeTcgplayerOrderInbound({ ...syntheticOrder })).externalReference).toBe(first.externalReference);
    expect((await composeTcgplayerOrderInbound({ ...syntheticOrder, pullId: "next" })).externalReference).not.toBe(
      first.externalReference,
    );
    expect((await composeTcgplayerOrderInbound(summary)).externalReference).toMatch(/^tcgp\.v1:[a-f0-9]{64}$/);
  });
  it("exports a browser-safe composer and snapshots input before awaiting the digest", async () => {
    const { composeTcgplayerOrderInbound: compose } = await import("../../../client");
    const input = structuredClone(syntheticOrder);
    const pending = compose(input);
    Object.assign(input, { orderNumber: "changed" });
    const result = await pending;
    expect(result.payload.records[0]).toEqual(syntheticOrder);
    expect(result.externalReference).toBe("tcgo.v1:a67334f7e0279d72351fe83939a9a3aeeef4248e185fb4def8d7edd1ba6d7e59");
    expect(readFileSync(new URL("../domain/contracts.ts", import.meta.url), "utf8")).not.toMatch(/node:|Buffer\./);
    expect(
      readFileSync(new URL("../../listing-composition/domain/canonical-json.ts", import.meta.url), "utf8"),
    ).not.toMatch(/node:|Buffer\./);
  });
  it.each([
    { ...syntheticOrder, buyerName: "private" },
    { ...syntheticOrder, lines: [{ ...syntheticOrder.lines[0], metadata: {} }] },
    { ...syntheticOrder, soldAt: "2026-09-12" },
    { ...syntheticOrder, soldAt: "2026-09-12T00:00:00" },
    { ...syntheticOrder, lines: [{ ...syntheticOrder.lines[0], quantity: 0 }] },
    { ...syntheticOrder, lines: [{ ...syntheticOrder.lines[0], skuId: "00101" }] },
    { ...syntheticOrder, lines: [{ ...syntheticOrder.lines[0], unitPriceAmount: "1.001" }] },
    { ...summary, range: { ...summary.range, metadata: {} } },
    { ...summary, pages: [{ ...summary.pages[0], unsafeNextLink: "https://invalid" }] },
    { ...summary, completion: "complete", unknownReason: "page-cap" },
  ])("rejects nested unknown or invalid closed fields %#", (record) =>
    expect(() => assertTcgplayerOrderRecord(record)).toThrow(),
  );
  it("accepts the line cap and rejects cap plus one", () => {
    expect(() =>
      assertTcgplayerOrderRecord({
        ...syntheticOrder,
        lines: Array.from({ length: 500 }, () => syntheticOrder.lines[0]),
      }),
    ).not.toThrow();
    expect(() =>
      assertTcgplayerOrderRecord({
        ...syntheticOrder,
        lines: Array.from({ length: 501 }, () => syntheticOrder.lines[0]),
      }),
    ).toThrow();
  });
  it("leaves missing and repeated identities ambiguous instead of inventing ordinals", () => {
    expect([
      ...ambiguousLineIndexes({
        ...syntheticOrder,
        lines: [syntheticOrder.lines[0]!, syntheticOrder.lines[0]!, { ...syntheticOrder.lines[0]!, skuId: null }],
      }),
    ]).toEqual([0, 1, 2]);
  });
  it.each([
    [{ ...summary, pages: [] }, "missing-page"],
    [{ ...summary, pages: [{ offset: 1, count: 1, totalOrders: 1 }] }, "pagination-drift"],
    [{ ...summary, pages: [{ offset: 0, count: 1, totalOrders: 2 }] }, "pagination-drift"],
    [{ ...summary, totalOrders: 2, pages: [{ offset: 0, count: 1, totalOrders: 2 }] }, "missing-page"],
    [{ ...summary, completion: "unknown", unknownReason: "page-cap" }, "page-cap"],
    [summary, null],
  ] as const)("keeps incomplete paging unknown %#", (record, gap) => expect(pullSummaryGap(record)).toBe(gap));
  it("enforces the admitted-reader boundary for interpretation and recovery", () => {
    const source = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
    expect(source).toContain("deps.readAdmittedConnectorInboundEvents");
    expect(source).not.toMatch(/(?:FROM|JOIN|DELETE FROM)\s+channel_connector_inbound_/i);
  });
});
