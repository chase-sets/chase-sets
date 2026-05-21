import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createExperienceApiClient, ExperienceApiError, experienceApi } from "../../client";
export type {
  ExperienceApiClientOptions,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackPromptEligibility,
} from "../../client";
import { createExperienceApiClient } from "../../client";

export function createExperienceRequestApiClient(request: Request) {
  return createExperienceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/experience"),
    fetch: createForwardedAuthFetch(request),
  });
}
