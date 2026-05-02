export type RealtimeRouteSubscriptionPreset = Readonly<{
  route: string;
  topics: readonly string[];
}>;

export function createRealtimeRouteSubscriptionPreset(
  route: string,
  topics: readonly string[],
): RealtimeRouteSubscriptionPreset {
  return {
    route,
    topics,
  };
}
