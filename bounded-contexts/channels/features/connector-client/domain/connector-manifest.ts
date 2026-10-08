import { TCGPLAYER_CONNECTOR_EXTENSION_KEY } from "./identity";

export const connectorPermissions = ["identity", "storage", "alarms"] as const;
export type ConnectorManifestInput = Readonly<{
  platformOrigin: string;
  hostRegistry: readonly Readonly<{ origin: string; capture: string }>[];
  permissionRegistry: readonly string[];
}>;

function origin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    value.includes("*") ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("connector-manifest-origin-refused");
  return value;
}

function exactKeys(value: object, keys: readonly string[]) {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("connector-manifest-fields-refused");
}

export function buildConnectorManifest(input: ConnectorManifestInput) {
  exactKeys(input, ["platformOrigin", "hostRegistry", "permissionRegistry"]);
  const platformOrigin = origin(input.platformOrigin);
  if (
    input.permissionRegistry.length !== connectorPermissions.length ||
    new Set(input.permissionRegistry).size !== connectorPermissions.length ||
    input.permissionRegistry.some((permission) => !connectorPermissions.includes(permission as never))
  )
    throw new Error("connector-manifest-permission-refused");
  const hosts = input.hostRegistry.map((entry) => {
    exactKeys(entry, ["origin", "capture"]);
    const capture = new URL(entry.capture);
    if (capture.protocol !== "https:" || capture.username || capture.password)
      throw new Error("connector-manifest-capture-refused");
    return origin(entry.origin);
  });
  return {
    manifest_version: 3,
    name: "Chase Sets TCGplayer Connector",
    version: "0.1.0",
    key: TCGPLAYER_CONNECTOR_EXTENSION_KEY,
    background: { service_worker: "background.js", type: "module" },
    permissions: [...connectorPermissions],
    host_permissions: [...new Set([platformOrigin, ...hosts])].sort().map((host) => `${host}/*`),
    action: { default_title: "unpaired" },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  } as const;
}

export function assertConnectorManifest(value: unknown, input: ConnectorManifestInput): void {
  function equal(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
    if (Array.isArray(actual) !== Array.isArray(expected)) return false;
    const keys = Object.keys(expected);
    return (
      Object.keys(actual).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(actual, key) &&
          equal((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]),
      )
    );
  }
  if (!equal(value, buildConnectorManifest(input))) throw new Error("connector-manifest-graph-refused");
}
