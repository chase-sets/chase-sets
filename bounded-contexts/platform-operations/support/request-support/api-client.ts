import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createExperienceApiClient, ExperienceApiError, experienceApi } from "./platform-feedback-client";
export type {
  ExperienceApiClientOptions,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackPromptEligibility,
} from "./platform-feedback-client";
import { createExperienceApiClient } from "./platform-feedback-client";

export function createExperienceRequestApiClient(request: Request) {
  return createExperienceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/experience"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
