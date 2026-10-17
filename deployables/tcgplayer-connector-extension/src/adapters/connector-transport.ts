import {
  buildConnectorManifest,
  isLiveExportAuthorityRequest,
  type ConnectorBackgroundPorts,
} from "@chase-sets/channels/client";

export function connectorTransport(
  input: Parameters<typeof buildConnectorManifest>[0],
): ConnectorBackgroundPorts["transport"]["request"] {
  const allowed = new Set(buildConnectorManifest(input).host_permissions.map((host) => host.slice(0, -2)));
  return async (request) => {
    const url = new URL(request.url);
    // Only a registered provider GET matching the Channels live-export authority may observe a redirect unfollowed.
    const redirect =
      request.redirect === "error" ||
      (request.redirect === "manual" && url.origin !== input.platformOrigin && isLiveExportAuthorityRequest(request));
    if (!allowed.has(url.origin) || url.username || url.password || !redirect)
      throw new Error("connector-transport-origin-refused");
    return fetch(request);
  };
}
