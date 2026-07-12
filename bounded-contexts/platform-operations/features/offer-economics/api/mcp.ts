import type { McpResourceHandler, McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { OfferEconomicsServices } from "./offer-economics-runtime";

export type OfferEconomicsMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

/**
 * Platform-wide operator surface (not account-self-scoped), so this checks
 * `insights-dashboards.view` directly rather than `ensureMcpActorAccount`
 * (which asserts the actor's OWN account id -- there is no such concept
 * here; every caller with the permission sees the same platform-wide
 * cohort numbers, exactly like the HTTP route's `requireActor`).
 */
function ensureInsightsViewer(actor: { permissions: readonly string[] } | null): void {
  if (!actor || !actor.permissions.includes("insights-dashboards.view")) {
    throw new Error("insights-dashboards.view is required to read the offer-economics monitor.");
  }
}

function readOptionalDate(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function createOfferEconomicsMcpHandlers(services: OfferEconomicsServices): OfferEconomicsMcpHandlers {
  const getOfferEconomicsSummary: McpToolHandler = async ({ actor, arguments: args }) => {
    ensureInsightsViewer(actor);
    const to = readOptionalDate(args, "to") ?? todayUtc();
    const from = readOptionalDate(args, "from") ?? daysAgoUtc(59, new Date(to));
    const accountType = readOptionalDate(args, "accountType");
    const snapshot = await services.getOfferEconomicsSnapshot({ from, to, accountType });
    return { snapshot };
  };

  const readOfferEconomicsSummaryResource: McpResourceHandler = async ({ actor }) => {
    ensureInsightsViewer(actor);
    const to = todayUtc();
    const from = daysAgoUtc(59, new Date(to));
    const snapshot = await services.getOfferEconomicsSnapshot({ from, to });
    return { snapshot };
  };

  return {
    toolHandlers: {
      "platform-operations.get-offer-economics-summary": getOfferEconomicsSummary,
    },
    resourceHandlers: {
      "chase-sets://platform-operations/offer-economics/summary": readOfferEconomicsSummaryResource,
    },
  };
}
