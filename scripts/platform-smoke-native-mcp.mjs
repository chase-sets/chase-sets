export const nativeMcpProtocolMatrix = Object.freeze(["2025-06-18", "2025-11-25", "2026-07-28"]);

const statelessProtocolVersion = "2026-07-28";
const protocolVersionHeader = "MCP-Protocol-Version";
const methodHeader = "Mcp-Method";
const nameHeader = "Mcp-Name";
const metaProtocolVersionKey = "io.modelcontextprotocol/protocolVersion";
const metaClientInfoKey = "io.modelcontextprotocol/clientInfo";
const metaClientCapabilitiesKey = "io.modelcontextprotocol/clientCapabilities";

export function isNativeMcpAnonymousDiscoveryRejected(response) {
  return [401, 403, 405].includes(response.status);
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
