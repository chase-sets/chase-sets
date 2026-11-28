import vocabulary from "../domain/rail-analytics-vocabulary.json" with { type: "json" };

export type ItemDetailRailAnalyticsEventName = keyof typeof vocabulary.events;
type ItemDetailRailAnalyticsLabelName = keyof typeof vocabulary.labels;
export const itemDetailRailAnalyticsEventNames = Object.keys(
  vocabulary.events,
) as readonly ItemDetailRailAnalyticsEventName[];

export type ItemDetailRailAnalyticsIntent = "buy" | "sell" | "watch" | "unknown";
export type ItemDetailRailAnalyticsSelection = "explicit" | "implicit" | "none";
export type ItemDetailRailAnalyticsViewer = "guest" | "signed_in" | "unknown";

export type ItemDetailRailAnalyticsProperties = Readonly<
  Partial<
    Record<ItemDetailRailAnalyticsLabelName, string> & {
      intent: ItemDetailRailAnalyticsIntent;
      selection: ItemDetailRailAnalyticsSelection;
      viewer: ItemDetailRailAnalyticsViewer;
      position: number;
      queryHash: string;
      resultSetKey: string;
    }
  >
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
