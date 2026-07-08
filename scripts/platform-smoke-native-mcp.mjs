export const nativeMcpProtocolMatrix = Object.freeze(["2025-06-18", "2025-11-25", "2026-07-28"]);
export const nativeMcpAnonymousDiscoveryToolNames = Object.freeze([
  "discovery.get-chatgpt-product-feed",
  "discovery.get-item-detail",
  "discovery.search-market",
]);
export const nativeMcpAccountScopedToolNames = Object.freeze([
  "marketplace.accept-offer",
  "marketplace.counter-offer",
  "marketplace.create-listing",
  "marketplace.decline-offer",
  "marketplace.get-reputation-summary",
  "marketplace.get-seller-insights",
  "marketplace.list-listings",
  "marketplace.list-offers",
  "marketplace.list-reviews",
  "marketplace.publish-listing",
  "marketplace.submit-offer",
  "marketplace.unpublish-listing",
  "marketplace.update-listing-price",
]);

const statelessProtocolVersion = "2026-07-28";
const protocolVersionHeader = "MCP-Protocol-Version";
const methodHeader = "Mcp-Method";
const nameHeader = "Mcp-Name";
const metaProtocolVersionKey = "io.modelcontextprotocol/protocolVersion";
const metaClientInfoKey = "io.modelcontextprotocol/clientInfo";
const metaClientCapabilitiesKey = "io.modelcontextprotocol/clientCapabilities";

export function summarizeNativeMcpAnonymousDiscoveryTools(body) {
  const tools = body?.result?.tools;
  if (!Array.isArray(tools)) {
    return {
      isValid: false,
      toolNames: [],
      diagnostic: "Native MCP anonymous discovery did not expose result.tools as an array.",
    };
  }

  const toolNames = tools
    .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
    .filter((toolName) => toolName !== null)
    .sort();
  const allowedToolNames = new Set(nativeMcpAnonymousDiscoveryToolNames);
  const unexpectedToolNames = toolNames.filter((toolName) => !allowedToolNames.has(toolName));
  const leakedAccountScopedToolNames = toolNames.filter((toolName) =>
    nativeMcpAccountScopedToolNames.includes(toolName),
  );
  const hasDiscoveryTool = toolNames.some((toolName) => toolName.startsWith("discovery."));

  if (!hasDiscoveryTool) {
    return {
      isValid: false,
      toolNames,
      diagnostic: `Native MCP anonymous discovery did not expose any public discovery tools. Tool names: ${toolNames.join(", ") || "(none)"}.`,
    };
  }

  if (leakedAccountScopedToolNames.length > 0) {
    return {
      isValid: false,
      toolNames,
      diagnostic: `Native MCP anonymous discovery exposed account-scoped tools: ${leakedAccountScopedToolNames.join(", ")}.`,
    };
  }

  if (unexpectedToolNames.length > 0) {
    return {
      isValid: false,
      toolNames,
      diagnostic: `Native MCP anonymous discovery exposed non-public tools: ${unexpectedToolNames.join(", ")}.`,
    };
  }

  return {
    isValid: true,
    toolNames,
    diagnostic: `Native MCP anonymous discovery tools: ${toolNames.join(", ")}.`,
  };
}

export function isNativeMcpPermissionBoundaryError(error, expectedPermission) {
  return error?.message === `Missing required permission: ${expectedPermission}.`;
}

export function readNativeMcpToolTextMessages(result) {
  return Array.isArray(result?.content)
    ? result.content
        .map((entry) => (entry?.type === "text" && typeof entry.text === "string" ? entry.text : null))
        .filter((text) => text !== null)
    : [];
}

export function isNativeMcpPermissionBoundaryResult(result, expectedPermission) {
  return (
    result?.isError === true &&
    readNativeMcpToolTextMessages(result).some(
      (message) => message.trim() === `Missing required permission: ${expectedPermission}.`,
    )
  );
}

export function readNativeMcpToolStructuredContent(result) {
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent;
  }

  const textBlock = readNativeMcpToolTextMessages(result)[0] ?? null;
  if (!textBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(textBlock);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function summarizeNativeMcpImportSourceKeys(result) {
  const structuredContent = readNativeMcpToolStructuredContent(result);
  const items = structuredContent?.items;
  if (!Array.isArray(items)) {
    return {
      hasExpectedSource: false,
      sourceKeys: [],
      diagnostic: structuredContent
        ? `Native MCP import source result did not expose an items array. Structured keys: ${Object.keys(
            structuredContent,
          ).join(", ")}.`
        : "Native MCP import source result did not expose structuredContent or parseable text JSON.",
    };
  }

  const sourceKeys = items
    .map((item) => (typeof item?.sourceKey === "string" ? item.sourceKey : null))
    .filter((sourceKey) => sourceKey !== null)
    .sort();

  return {
    hasExpectedSource: sourceKeys.includes("tcgplayer-csv"),
    sourceKeys,
    diagnostic:
      sourceKeys.length > 0
        ? `Native MCP import source keys: ${sourceKeys.join(", ")}.`
        : "Native MCP import source result had an empty items array or items without sourceKey.",
  };
}

function statelessMcpMeta() {
  return {
    [metaProtocolVersionKey]: statelessProtocolVersion,
    [metaClientInfoKey]: {
      name: "platform-smoke",
      version: "0.1.0",
    },
    [metaClientCapabilitiesKey]: {},
  };
}

function requestParamsForRevision(revision, params) {
  if (revision !== statelessProtocolVersion) {
    return params;
  }

  return {
    ...(params && typeof params === "object" && !Array.isArray(params) ? params : {}),
    _meta: statelessMcpMeta(),
  };
}

export function nativeMcpHeadersForRevision(revision, method, name, extraHeaders = {}) {
  return {
    "Content-Type": "application/json",
    ...extraHeaders,
    ...(revision === statelessProtocolVersion
      ? {
          [protocolVersionHeader]: statelessProtocolVersion,
          [methodHeader]: method,
          ...(name ? { [nameHeader]: name } : {}),
        }
      : revision === "2025-11-25"
        ? {
            [protocolVersionHeader]: revision,
          }
        : {}),
  };
}

export function nativeMcpJsonRpcRequestForRevision(revision, id, method, params) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined && revision !== statelessProtocolVersion
      ? {}
      : { params: requestParamsForRevision(revision, params) }),
  };
}

export function shouldInitializeNativeMcpRevision(revision) {
  return revision !== statelessProtocolVersion;
}
