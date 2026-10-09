import { buildConnectorManifest } from "@chase-sets/channels";
import type { ConnectorBackgroundPorts } from "@chase-sets/channels/client";

export function connectorTransport(
  input: Parameters<typeof buildConnectorManifest>[0],
): ConnectorBackgroundPorts["transport"]["request"] {
  const allowed = new Set(buildConnectorManifest(input).host_permissions.map((host) => host.slice(0, -2)));
  return async (request) => {
    const url = new URL(request.url);
    if (!allowed.has(url.origin) || url.username || url.password || request.redirect !== "error")
      throw new Error("connector-transport-origin-refused");
    return fetch(request);
  };
}
