export const MCP_PROTOCOL_VERSION_2025_06_18 = "2025-06-18";
export const MCP_PROTOCOL_VERSION_2025_11_25 = "2025-11-25";
export const MCP_PROTOCOL_VERSION_2026_07_28 = "2026-07-28";

export const MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION_2025_06_18;
export const MCP_STATELESS_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION_2026_07_28;

export const MCP_LEGACY_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION_2025_06_18, MCP_PROTOCOL_VERSION_2025_11_25] as const;

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION_2025_06_18,
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_2026_07_28,
] as const;

export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const MCP_METHOD_HEADER = "Mcp-Method";
export const MCP_NAME_HEADER = "Mcp-Name";
export const MCP_SESSION_ID_HEADER = "Mcp-Session-Id";
export const MCP_CLIENT_NAME_HEADER = "Mcp-Client-Name";
export const MCP_CLIENT_VERSION_HEADER = "Mcp-Client-Version";
export const MCP_CLIENT_CAPABILITIES_HEADER = "Mcp-Client-Capabilities";

export const MCP_META_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_META_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

export const MCP_EXTENSION_TASKS = "io.modelcontextprotocol/tasks";
export const MCP_EXTENSION_UI = "io.modelcontextprotocol/ui";
export const MCP_UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSupportedMcpProtocolVersion(value: string): value is McpProtocolVersion {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(value as McpProtocolVersion);
}

export function isStatelessMcpProtocolVersion(value: string): value is typeof MCP_STATELESS_PROTOCOL_VERSION {
  return value === MCP_STATELESS_PROTOCOL_VERSION;
}

export function negotiateMcpProtocolVersion(
  params: unknown,
  supportedVersions: readonly string[] = SUPPORTED_MCP_PROTOCOL_VERSIONS,
): string {
  const requestedVersion = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";

  return supportedVersions.includes(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION;
}

export function readMcpHeaderValue(request: Request, name: string) {
  const value = request.headers.get(name);
  return value === null || value.trim().length === 0 ? null : value.trim();
}

export function isValidMcpHeaderValue(value: string) {
  return !/[\0\r\n]/.test(value);
}
