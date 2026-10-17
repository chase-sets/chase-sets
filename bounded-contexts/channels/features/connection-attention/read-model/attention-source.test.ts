import { describe, expect, it } from "vitest";
import { isSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import { createChannelActionAttentionSource } from "./attention-source";

describe("channel-action-manual-sync-source-contract", () => {
  it("keeps order-only and mixed manual work in the existing source with bounded counts", async () => {
    const source = createChannelActionAttentionSource(async () => [
      {
        connectionId: "connection",
        healthState: "unknown",
        health: [],
        manual: { connectionId: "connection", reason: "ready", observedAt: "2026-09-10T12:00:00Z" },
        orders: {
          count: 100,
          hasMore: true,
          nextCursor: "next",
          items: [
            {
              externalOrderReference: "synthetic-order",
              reason: "tcgplayer-order-unmapped",
              generation: 1,
              openedAt: "2026-09-10T12:00:00Z",
              affectedLineCount: 0,
            },
          ],
        },
      },
    ]);
    const [item] = await source.load({ accountId: "account", now: "2026-09-10T13:00:00Z" });
    expect(item?.source).toBe("channel-action");
    expect(item?.summary).toMatchObject({
      code: "channel-action-open",
      params: {
        manualReason: "ready",
        externalOrderReference: "synthetic-order",
        orderReason: "tcgplayer-order-unmapped",
        orderCount: 100,
        orderOverflow: 1,
      },
    });
    expect(item && isSellerAttentionItem(item, "channel-action")).toBe(true);
  });
  it("emits isolated ready, unknown, and recovery reasons with canonical deep links", async () => {
    const source = createChannelActionAttentionSource(async (accountId) =>
      (
        [
          { connectionId: `${accountId}-ready`, reason: "ready", observedAt: "2026-09-10T12:00:00Z" },
          { connectionId: `${accountId}-unknown`, reason: "unknown", observedAt: "2026-09-10T12:01:00Z" },
          { connectionId: `${accountId}-recovery`, reason: "recovery", observedAt: "2026-09-10T12:02:00Z" },
        ] as const
      ).map((manual) => ({ connectionId: manual.connectionId, healthState: "unknown", health: [], manual })),
    );
    const items = await source.load({ accountId: "account-owner", now: "2026-09-10T13:00:00Z" });
    expect(items).toHaveLength(3);
    expect(items.every((item) => isSellerAttentionItem(item, "channel-action"))).toBe(true);
    expect(
      items.map((item) => ({ code: item.summary.code, severity: item.severity, href: item.deepLink.href })),
    ).toEqual([
      { code: "channel-ready", severity: "info", href: "/account/channels/account-owner-ready" },
      { code: "channel-unknown", severity: "warning", href: "/account/channels/account-owner-unknown" },
      { code: "channel-recovery", severity: "warning", href: "/account/channels/account-owner-recovery" },
    ]);
  });
});
