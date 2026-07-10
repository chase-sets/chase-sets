export const itemDetailRailAnalyticsEventNames = [
  "rail_intent_selected",
  "workflow_selected",
  "similar_item_selected",
  "reference_info_opened",
  "payout_preview_shown",
  "standard_preview_unavailable",
  "registration_gate_shown",
  "registration_started",
  "registration_return_completed",
  "term_delta_reviewed",
  "intent_persisted",
  "commit_gate_reached",
  "intent_submit_started",
  "validation_failed",
] as const;

export type ItemDetailRailAnalyticsEventName = (typeof itemDetailRailAnalyticsEventNames)[number];

export type ItemDetailRailAnalyticsIntent = "buy" | "sell" | "watch" | "unknown";
export type ItemDetailRailAnalyticsSelection = "explicit" | "implicit" | "none";
export type ItemDetailRailAnalyticsViewer = "guest" | "signed_in" | "unknown";

export type ItemDetailRailAnalyticsProperties = Readonly<
  Partial<{
    intent: ItemDetailRailAnalyticsIntent;
    workflow: string;
    selection: ItemDetailRailAnalyticsSelection;
    topic: string;
    outcome: string;
    gate: string;
    viewer: ItemDetailRailAnalyticsViewer;
    surface: string;
  }>
>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export function trackItemDetailRailEvent(
  eventName: ItemDetailRailAnalyticsEventName,
  properties: ItemDetailRailAnalyticsProperties = {},
) {
  if (typeof window === "undefined") {
    return;
  }

  const detail = {
    event: eventName,
    ...properties,
  };

  window.dispatchEvent(new CustomEvent("chase-sets:item-detail-rail-analytics", { detail }));
  window.dataLayer?.push(detail);
}
