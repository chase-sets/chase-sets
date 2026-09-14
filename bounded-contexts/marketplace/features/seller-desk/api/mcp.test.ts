import { describe, expect, it, vi } from "vitest";
import { aggregateSellerAttentionQueue, buildSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createSellerDeskMcpHandlers } from "./mcp";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import { createSellerAttentionQueueRoutes } from "./route";
import { createSellerAttentionQueueRuntime } from "../read-model/runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_seller",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view", "channels.view"],
} satisfies ResolvedActor;

const protocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

describe("Seller Desk MCP handlers", () => {
  it("channel-action-shared-facades carries the identical mixed descriptor and single rollup over HTTP and MCP", async () => {
    const item = buildSellerAttentionItem({
      source: "channel-action",
      entityId: "synthetic-connection",
      severity: "critical",
      summary: {
        code: "channel-action-open",
        params: {
          reasonCount: 1,
          topReason: "polling",
          manualReason: "recovery",
          connectionId: "synthetic-connection",
        },
      },
      observedAt: "2026-09-13T00:00:00Z",
    });
    const queue = createSellerAttentionQueueRuntime([{ id: "channel-action", load: async () => [item] }]);
    const app = new Hono<MarketplaceApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route("/", createSellerAttentionQueueRoutes(queue));
    const web = await (await app.request("http://local/")).json();
    const handlers = createSellerDeskMcpHandlers(queue);
    const mcp = await handlers.toolHandlers["marketplace.get-seller-attention-queue"]({
      actor,
      tool: null as never,
      arguments: { accountId: actor.accountId },
      request: new Request("http://local/mcp"),
      protocol,
    });
    expect(web).toEqual(mcp);
    expect(web.items).toEqual([item]);
    expect(web.rollup.total).toBe(1);
    expect(web.rollup.bySource["channel-action"]).toBe(1);
  });
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
