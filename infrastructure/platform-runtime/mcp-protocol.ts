export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function negotiateMcpProtocolVersion(params: unknown): string {
  const requestedVersion = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";

  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion as (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number])
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;
}
