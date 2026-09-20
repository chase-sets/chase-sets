import { loader as connectionLoader } from "../../features/connections/ui/account-channels-connection-route-adapter";
import { defineApiErrorAdapter, defineResourceRoute } from "@chase-sets/platform-runtime/http";
import contextManifest from "../../context.json";
import { ChannelsConnectionsApiError } from "../../support/request-support/api-client";

export {
  action,
  clientAction,
  default,
  downloadAction,
  meta,
  readActionError,
} from "../../features/connections/ui/account-channels-connection-route-adapter";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "channels-connection-detail",
  errorAdapter: defineApiErrorAdapter({
    isError: (error): error is ChannelsConnectionsApiError => error instanceof ChannelsConnectionsApiError,
    getStatus: (error) => error.status,
    getBody: (error) => error.body,
  }),
  load: connectionLoader,
  map: (data) => data,
  onPending: () => ({ kind: "loading" as const }),
  onPermanentFailure: (loaded) => {
    if ("error" in loaded) {
      if (loaded.error instanceof ChannelsConnectionsApiError && loaded.error.status === 404) {
        return { kind: "not-found" as const };
      }
      throw loaded.error;
    }
    return { kind: "not-found" as const };
  },
});
