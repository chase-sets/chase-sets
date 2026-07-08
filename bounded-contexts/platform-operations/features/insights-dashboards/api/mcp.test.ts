import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createInsightsDashboardMcpHandlers } from "./mcp";
import type { InsightsDashboardQueryService } from "../read-model/queries";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["accounts.view"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function queryService(): InsightsDashboardQueryService {
  return {
    getSalesPerformanceKpi: vi.fn(async ({ accountId }) => ({
      accountId,
      acceptedOfferCount: 2,
      paidOrderCount: 1,
      grossSalesAmount: 75,
    })),
    getFulfillmentLatencyKpi: vi.fn(async ({ accountId }) => ({
      accountId,
      deliveredShipmentCount: 1,
      averageLatencyHours: 24,
    })),
    getConversionOrderKpi: vi.fn(async ({ accountId }) => ({
      accountId,
      listingViewCount: 20,
      orderPlacedCount: 2,
      conversionRate: 0.1,
    })),
  };
}

describe("insights dashboard MCP handlers", () => {
  it("returns the seller insight summary for the authenticated account", async () => {
    const fakeQueryService = queryService();
    const handlers = createInsightsDashboardMcpHandlers(fakeQueryService);

    const result = await handlers.toolHandlers["platform-operations.get-seller-insight-summary"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1" },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toEqual({
      accountId: "acc_1",
      salesPerformanceKpi: {
        accountId: "acc_1",
        acceptedOfferCount: 2,
        paidOrderCount: 1,
        grossSalesAmount: 75,
      },
      fulfillmentLatencyKpi: {
        accountId: "acc_1",
        deliveredShipmentCount: 1,
        averageLatencyHours: 24,
      },
      conversionOrderKpi: {
        accountId: "acc_1",
        listingViewCount: 20,
        orderPlacedCount: 2,
        conversionRate: 0.1,
      },
    });
  });

  it("rejects account mismatches before reading KPI data", async () => {
    const fakeQueryService = queryService();
    const handlers = createInsightsDashboardMcpHandlers(fakeQueryService);

    await expect(
      handlers.toolHandlers["platform-operations.get-seller-insight-summary"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other" },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeQueryService.getSalesPerformanceKpi).not.toHaveBeenCalled();
  });

  it("reads the insight summary resource by URI", async () => {
    const handlers = createInsightsDashboardMcpHandlers(queryService());

    const result = await handlers.resourceHandlers["chase-sets://platform-operations/{accountId}/insights/summary"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://platform-operations/acc_1/insights/summary",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      salesPerformanceKpi: { acceptedOfferCount: 2 },
    });
  });
});
