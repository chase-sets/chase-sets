import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { InsightsDashboardQueryService } from "../read-model/queries";

export type InsightsDashboardMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function insightSummaryUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/platform-operations\/([^/]+)\/insights\/summary$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
  };
}

async function getAccountSummary(queryService: InsightsDashboardQueryService, accountId: string) {
  const [salesPerformanceKpi, fulfillmentLatencyKpi, conversionOrderKpi] = await Promise.all([
    queryService.getSalesPerformanceKpi({ accountId }),
    queryService.getFulfillmentLatencyKpi({ accountId }),
    queryService.getConversionOrderKpi({ accountId }),
  ]);

  return {
    accountId,
    salesPerformanceKpi,
    fulfillmentLatencyKpi,
    conversionOrderKpi,
  };
}

export function createInsightsDashboardMcpHandlers(
  queryService: InsightsDashboardQueryService,
): InsightsDashboardMcpHandlers {
  const getSellerInsightSummary: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);

    return getAccountSummary(queryService, scopedActor.accountId);
  };

  const readInsightSummaryResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = insightSummaryUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported platform operations insight summary resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    return getAccountSummary(queryService, scopedActor.accountId);
  };

  return {
    toolHandlers: {
      "platform-operations.get-seller-insight-summary": getSellerInsightSummary,
    },
    resourceHandlers: {
      "chase-sets://platform-operations/{accountId}/insights/summary": readInsightSummaryResource,
    },
  };
}
