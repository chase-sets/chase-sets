export type ItemDetailRailAnalyticsEvent = Readonly<{
  event: string;
  intent?: string | null;
  workflow?: string | null;
  selection?: string | null;
  topic?: string | null;
  outcome?: string | null;
  gate?: string | null;
  viewer?: string | null;
  surface?: string | null;
  position?: number | null;
  queryHash?: string | null;
  resultSetKey?: string | null;
}>;

export type ItemDetailRailAnalyticsRecorder = (event: ItemDetailRailAnalyticsEvent) => void;

let recorder: ItemDetailRailAnalyticsRecorder | null = null;

export function registerItemDetailRailAnalyticsRecorder(next: ItemDetailRailAnalyticsRecorder | null) {
  const previous = recorder;
  recorder = next;
  return () => {
    if (recorder === next) recorder = previous;
  };
}

export function recordPlatformItemDetailRailAnalytics(event: ItemDetailRailAnalyticsEvent) {
  recorder?.(event);
}
