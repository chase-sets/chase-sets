import { describe, expect, it, vi } from "vitest";
import { aggregateSellerAttentionQueue, buildSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSellerDeskMcpHandlers } from "./mcp";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_seller",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
} satisfies ResolvedActor;

const protocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

describe("Seller Desk MCP handlers", () => {
  it("returns the same aggregated queue object that the web Seller Desk consumes", async () => {
    const expected = await aggregateSellerAttentionQueue(
      [
        {
          id: "listing-action",
          load: async () => [
            buildSellerAttentionItem({
              source: "listing-action",
              entityId: "lst_1",
              severity: "info",
              summary: { code: "listing-needs-action", params: { action: "paused" } },
              observedAt: "2026-07-15T00:00:00.000Z",
            }),
          ],
        },
      ],
      { accountId: "acc_seller", now: "2026-07-15T12:00:00.000Z" },
    );
    const loadQueue = vi.fn(async () => expected);
    const handlers = createSellerDeskMcpHandlers({ loadQueue }, () => "2026-07-15T12:00:00.000Z");

    const result = await handlers.toolHandlers["marketplace.get-seller-attention-queue"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_seller" },
      request: new Request("https://api.test/mcp"),
      protocol,
    });

    expect(result).toEqual(expected);
    expect(loadQueue).toHaveBeenCalledWith({
      accountId: "acc_seller",
      now: "2026-07-15T12:00:00.000Z",
    });
  });

  it("rejects an account outside the authenticated seller scope", async () => {
    const handlers = createSellerDeskMcpHandlers({ loadQueue: vi.fn() });

    await expect(
      handlers.toolHandlers["marketplace.get-seller-attention-queue"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other" },
        request: new Request("https://api.test/mcp"),
        protocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
  });
});
