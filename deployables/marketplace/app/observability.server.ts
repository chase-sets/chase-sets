import { registerPostWriteConsistencyRecorder } from "@chase-sets/platform-runtime/post-write-consistency";
import {
  loadObservabilityConfig,
  recordPostWriteConsistencyEvent,
  startObservability,
} from "@chase-sets/observability";

let postWriteConsistencyRecorderRegistered = false;

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
