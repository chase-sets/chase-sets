import { loader as connectionLoader } from "../../features/connections/ui/account-channels-connection-route-adapter";
import { loadAfterWrite } from "@chase-sets/platform-runtime/http";
import type { LoaderFunctionArgs } from "react-router";
import { ChannelsConnectionsApiError } from "../../support/request-support/api-client";

export {
  action,
  clientAction,
  default,
  downloadAction,
  meta,
  readActionError,
} from "../../features/connections/ui/account-channels-connection-route-adapter";

export const loader = async (args: LoaderFunctionArgs): ReturnType<typeof connectionLoader> => {
  const loaded = await loadAfterWrite({
    request: args.request,
    load: () => connectionLoader(args),
    isNotFound: (error) => error instanceof ChannelsConnectionsApiError && error.status === 404,
    getStatus: (error) => (error instanceof ChannelsConnectionsApiError ? error.status : null),
    getBody: (error) => (error instanceof ChannelsConnectionsApiError ? error.body : null),
  });
  if (loaded.kind === "pending") return { kind: "loading" };
  if (loaded.kind === "permanent-failure") {
    if ("error" in loaded) {
      if (loaded.error instanceof ChannelsConnectionsApiError && loaded.error.status === 404) {
        return { kind: "not-found" };
      }
      throw loaded.error;
    }
    return { kind: "not-found" };
  }
  return loaded.data;
};
