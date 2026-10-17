import { Buffer } from "node:buffer";

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

export type McpClientInfo = Readonly<{ name: string; version: string; [key: string]: unknown }>;
export type McpClientCapabilities = Readonly<Record<string, unknown>>;
export type McpRequestProtocolContext = Readonly<{
  protocolVersion: string;
  stateless: boolean;
  clientInfo: McpClientInfo | null;
  clientCapabilities: McpClientCapabilities | null;
}>;
export type McpProtocolRequest = Readonly<{ method?: string; params?: unknown }>;
export type McpProtocolPolicy = Readonly<{ name: "native" | "ucp-modern" }>;
export const NATIVE_MCP_PROTOCOL_POLICY = { name: "native" } as const satisfies McpProtocolPolicy;
export const UCP_MCP_MODERN_POLICY = { name: "ucp-modern" } as const satisfies McpProtocolPolicy;
export const UCP_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_STATELESS_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_2025_06_18,
] as const;

export type McpRequestProtocolFailure = Readonly<{ message: string }> &
  (
    | Readonly<{ kind: "unsupported-version"; requestedVersion: string; supportedVersions: readonly string[] }>
    | Readonly<{ kind: "invalid-header" | "header-mismatch" | "missing-stateless-header" | "invalid-stateless-params" }>
  );
export type McpRequestProtocolResolution =
  | Readonly<{ ok: true; protocol: McpRequestProtocolContext }>
  | Readonly<{ ok: false; failure: McpRequestProtocolFailure }>;

function failure(
  kind: Exclude<McpRequestProtocolFailure["kind"], "unsupported-version">,
  message: string,
): McpRequestProtocolResolution {
  return { ok: false, failure: { kind, message } };
}

function unsupportedVersion(
  requestedVersion: string,
  supportedVersions: readonly string[],
): McpRequestProtocolResolution {
  return {
    ok: false,
    failure: {
      kind: "unsupported-version",
      message: `Unsupported MCP protocol version '${requestedVersion}'.`,
      requestedVersion,
      supportedVersions,
    },
  };
}

export function paramsRecord(params: unknown): Readonly<Record<string, unknown>> {
  return isRecord(params) ? params : {};
}

export function mcpMetaFromParams(params: unknown) {
  const paramsObject = paramsRecord(params);
  return isRecord(paramsObject._meta) ? paramsObject._meta : {};
}

export function mcpMetaProtocolVersion(meta: Readonly<Record<string, unknown>>) {
  const protocolVersion = meta[MCP_META_PROTOCOL_VERSION_KEY];
  return typeof protocolVersion === "string" && protocolVersion.trim().length > 0 ? protocolVersion.trim() : null;
}

export function isModernUcpMcpRequest(request: McpProtocolRequest) {
  return (
    request.method !== "initialize" && Object.hasOwn(mcpMetaFromParams(request.params), MCP_META_PROTOCOL_VERSION_KEY)
  );
}

function readMcpClientInfoFromMeta(meta: Readonly<Record<string, unknown>>): McpClientInfo | null {
  const clientInfo = meta[MCP_META_CLIENT_INFO_KEY];
  if (!isRecord(clientInfo)) return null;
  const { name, version } = clientInfo;
  return typeof name === "string" && name.trim().length > 0 && typeof version === "string" && version.trim().length > 0
    ? { ...clientInfo, name: name.trim(), version: version.trim() }
    : null;
}

function readMcpClientInfoFromHeaders(request: Request): McpClientInfo | null {
  const name = readMcpHeaderValue(request, MCP_CLIENT_NAME_HEADER);
  const version = readMcpHeaderValue(request, MCP_CLIENT_VERSION_HEADER);
  return name && version ? { name, version } : null;
}

function readMcpClientCapabilitiesFromHeaders(request: Request): McpClientCapabilities | null {
  const value = readMcpHeaderValue(request, MCP_CLIENT_CAPABILITIES_HEADER);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMcpClientCapabilities(
  request: Request,
  meta: Readonly<Record<string, unknown>>,
  policy: McpProtocolPolicy,
) {
  const capabilities = meta[MCP_META_CLIENT_CAPABILITIES_KEY];
  return isRecord(capabilities)
    ? capabilities
    : policy.name === "native"
      ? readMcpClientCapabilitiesFromHeaders(request)
      : null;
}

export function resolveMcpRequestProtocol(
  request: Request,
  rpcRequest: McpProtocolRequest,
  policy: McpProtocolPolicy,
): McpRequestProtocolResolution {
  const protocolHeader = readMcpHeaderValue(request, MCP_PROTOCOL_VERSION_HEADER);
  const meta = mcpMetaFromParams(rpcRequest.params);
  const metaProtocolVersion = mcpMetaProtocolVersion(meta);
  let protocolVersion: string = MCP_PROTOCOL_VERSION;

  if (policy.name === "ucp-modern") {
    if (!isModernUcpMcpRequest(rpcRequest)) {
      if (protocolHeader && !isValidMcpHeaderValue(protocolHeader)) {
        return failure("invalid-header", `${MCP_PROTOCOL_VERSION_HEADER} contains an invalid value.`);
      }
      if (
        protocolHeader &&
        !MCP_LEGACY_PROTOCOL_VERSIONS.includes(protocolHeader as (typeof MCP_LEGACY_PROTOCOL_VERSIONS)[number])
      ) {
        return unsupportedVersion(protocolHeader, MCP_LEGACY_PROTOCOL_VERSIONS);
      }
      return {
        ok: true,
        protocol: {
          protocolVersion: protocolHeader ?? MCP_PROTOCOL_VERSION,
          stateless: false,
          clientInfo: null,
          clientCapabilities: null,
        },
      };
    }
    if (!metaProtocolVersion) {
      return failure(
        "invalid-stateless-params",
        `params._meta.${MCP_META_PROTOCOL_VERSION_KEY} must be a nonempty string.`,
      );
    }
    if (!isSupportedMcpProtocolVersion(metaProtocolVersion)) {
      return unsupportedVersion(metaProtocolVersion, UCP_MCP_SUPPORTED_PROTOCOL_VERSIONS);
    }
    if (!protocolHeader) {
      return failure("missing-stateless-header", `${MCP_PROTOCOL_VERSION_HEADER} is required for this MCP request.`);
    }
    if (!isValidMcpHeaderValue(protocolHeader)) {
      return failure("invalid-header", `${MCP_PROTOCOL_VERSION_HEADER} contains an invalid value.`);
    }
    if (protocolHeader !== metaProtocolVersion) {
      return failure(
        "header-mismatch",
        `${MCP_PROTOCOL_VERSION_HEADER} must match params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`,
      );
    }
    protocolVersion = metaProtocolVersion;
  } else if (protocolHeader) {
    if (!isValidMcpHeaderValue(protocolHeader)) {
      return failure("invalid-header", `${MCP_PROTOCOL_VERSION_HEADER} contains an invalid value.`);
    }
    if (!isSupportedMcpProtocolVersion(protocolHeader)) {
      return unsupportedVersion(protocolHeader, SUPPORTED_MCP_PROTOCOL_VERSIONS);
    }
    protocolVersion = protocolHeader;
    if (metaProtocolVersion && metaProtocolVersion !== protocolHeader) {
      return failure(
        "header-mismatch",
        `${MCP_PROTOCOL_VERSION_HEADER} must match params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`,
      );
    }
  } else if (metaProtocolVersion) {
    if (!isSupportedMcpProtocolVersion(metaProtocolVersion)) {
      return unsupportedVersion(metaProtocolVersion, SUPPORTED_MCP_PROTOCOL_VERSIONS);
    }
    if (isStatelessMcpProtocolVersion(metaProtocolVersion)) {
      return failure(
        "missing-stateless-header",
        `${MCP_PROTOCOL_VERSION_HEADER} is required for MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION}.`,
      );
    }
    protocolVersion = metaProtocolVersion;
  }

  const stateless = policy.name === "ucp-modern" || isStatelessMcpProtocolVersion(protocolVersion);
  const clientInfo =
    readMcpClientInfoFromMeta(meta) ?? (policy.name === "native" ? readMcpClientInfoFromHeaders(request) : null);
  const clientCapabilities = readMcpClientCapabilities(request, meta, policy);
  if (stateless) {
    if (policy.name === "native" && metaProtocolVersion !== MCP_STATELESS_PROTOCOL_VERSION) {
      return failure(
        "invalid-stateless-params",
        `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`,
      );
    }
    if (policy.name === "native" && !clientInfo) {
      return failure(
        "invalid-stateless-params",
        `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires client info in params._meta.${MCP_META_CLIENT_INFO_KEY} or ${MCP_CLIENT_NAME_HEADER}/${MCP_CLIENT_VERSION_HEADER}.`,
      );
    }
    if (!clientCapabilities) {
      return failure(
        "invalid-stateless-params",
        `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires client capabilities in params._meta.${MCP_META_CLIENT_CAPABILITIES_KEY}${policy.name === "native" ? ` or ${MCP_CLIENT_CAPABILITIES_HEADER}` : ""}.`,
      );
    }
  }
  return { ok: true, protocol: { protocolVersion, stateless, clientInfo, clientCapabilities } };
}

export function expectedMcpNameHeaderValue(request: McpProtocolRequest) {
  const params = paramsRecord(request.params);
  switch (request.method) {
    case "tools/call":
    case "prompts/get":
      return typeof params.name === "string" ? params.name : null;
    case "resources/read":
      return typeof params.uri === "string" ? params.uri : null;
    default:
      return null;
  }
}

function decodedMcpName(value: string): string | null {
  if (!value.startsWith("=?base64?")) return value;
  const match = /^=\?base64\?((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)\?=$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.toString("base64") !== match[1]) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function validateMcpRoutingHeaders(
  request: Request,
  rpcRequest: McpProtocolRequest,
  protocol: McpRequestProtocolContext,
  policy: McpProtocolPolicy,
): McpRequestProtocolResolution {
  if (policy.name === "ucp-modern" && !protocol.stateless) return { ok: true, protocol };
  const methodHeader = readMcpHeaderValue(request, MCP_METHOD_HEADER);
  const nameHeader = readMcpHeaderValue(request, MCP_NAME_HEADER);
  const shouldValidate = protocol.stateless || methodHeader !== null || nameHeader !== null;
  if (!shouldValidate) return { ok: true, protocol };
  if (!methodHeader) return failure("header-mismatch", `${MCP_METHOD_HEADER} is required for this MCP request.`);
  if (!isValidMcpHeaderValue(methodHeader))
    return failure("invalid-header", `${MCP_METHOD_HEADER} contains an invalid value.`);
  if (methodHeader !== rpcRequest.method)
    return failure("header-mismatch", `${MCP_METHOD_HEADER} must match the JSON-RPC method.`);
  const expectedName = expectedMcpNameHeaderValue(rpcRequest);
  const needsName =
    policy.name === "ucp-modern"
      ? ["tools/call", "resources/read", "prompts/get"].includes(rpcRequest.method ?? "")
      : Boolean(expectedName);
  if (!needsName) return { ok: true, protocol };
  if (!nameHeader) return failure("header-mismatch", `${MCP_NAME_HEADER} is required for ${rpcRequest.method}.`);
  if (!isValidMcpHeaderValue(nameHeader))
    return failure("invalid-header", `${MCP_NAME_HEADER} contains an invalid value.`);
  const actualName = policy.name === "ucp-modern" ? decodedMcpName(nameHeader) : nameHeader;
  if (actualName !== expectedName)
    return failure("header-mismatch", `${MCP_NAME_HEADER} must match the MCP request target.`);
  return { ok: true, protocol };
}
