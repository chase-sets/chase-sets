import { registerPostWriteConsistencyRecorder } from "@chase-sets/platform-runtime/post-write-consistency";
import { registerItemDetailRailAnalyticsRecorder } from "@chase-sets/platform-runtime/analytics-recorder";
import {
  loadObservabilityConfig,
  recordPostWriteConsistencyEvent,
  recordItemDetailRailAnalytics,
  startObservability,
} from "@chase-sets/observability";

let postWriteConsistencyRecorderRegistered = false;

export function registerMarketplaceItemDetailRailAnalyticsRecorder() {
  registerItemDetailRailAnalyticsRecorder((payload) => {
    const observability = getMarketplaceObservability();
    recordItemDetailRailAnalytics(payload);
    observability.logger.info("Item detail rail analytics event captured.", {
      type: "marketplace.item_detail_rail.analytics_event",
      event: payload.event,
      intent: payload.intent,
      workflow: payload.workflow,
      selection: payload.selection,
      topic: payload.topic,
      outcome: payload.outcome,
      gate: payload.gate,
      viewer: payload.viewer,
      surface: payload.surface,
    });
  });
}

export function getMarketplaceObservability() {
  return startObservability(
    loadObservabilityConfig(process.env, {
      serviceName: "marketplace-web",
      serviceVersion: "0.1.0",
    }),
  );
}

export function registerMarketplacePostWriteConsistencyRecorder() {
  if (postWriteConsistencyRecorderRegistered) {
    return;
  }

  postWriteConsistencyRecorderRegistered = true;
  registerPostWriteConsistencyRecorder((event) => {
    getMarketplaceObservability();
    recordPostWriteConsistencyEvent(event);
  });
}
