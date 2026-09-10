import { describe, expect, it } from "vitest";
import { isSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import { createChannelActionAttentionSource } from "./attention-source";

describe("channel-action-manual-sync-source-contract", () => {
  it("emits isolated ready, unknown, and recovery reasons with canonical deep links", async () => {
    const source = createChannelActionAttentionSource(async (accountId) => [
      { connectionId: `${accountId}-ready`, reason: "ready", observedAt: "2026-09-10T12:00:00Z" },
      { connectionId: `${accountId}-unknown`, reason: "unknown", observedAt: "2026-09-10T12:01:00Z" },
      { connectionId: `${accountId}-recovery`, reason: "recovery", observedAt: "2026-09-10T12:02:00Z" },
    ]);
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
