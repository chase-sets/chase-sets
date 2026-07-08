import { createHash } from "node:crypto";
import type { RealtimeStreamLimiter } from "./realtime-stream-limiter";

export type McpToolCallLimitKind = "read" | "write" | "external-provider";

export type McpToolCallLimitRequest = Readonly<{
  transport: "native-mcp" | "ucp-mcp";
  toolName: string;
  limitKind: McpToolCallLimitKind;
  grantId?: string | null;
  actorId?: string | null;
  accountId?: string | null;
  agentProfileUrl?: string | null;
  clientAddress?: string | null;
}>;

export type McpToolCallLease = Readonly<{
  release: () => Promise<void> | void;
}>;

export type McpToolCallLimitResult =
  | Readonly<{
      allowed: true;
      lease: McpToolCallLease;
    }>
  | Readonly<{
      allowed: false;
      reason: string;
    }>;

export type McpToolCallLimiter = Readonly<{
  acquire: (request: McpToolCallLimitRequest) => Promise<McpToolCallLimitResult> | McpToolCallLimitResult;
}>;

export type McpToolCallLimiterFromRealtimeOptions = Readonly<{
  maxConcurrentToolCalls?: number;
  maxConcurrentToolCallsPerPrincipal?: number;
  maxConcurrentWriteToolCallsPerPrincipal?: number;
  maxConcurrentExternalProviderToolCallsPerPrincipal?: number;
}>;

export const DEFAULT_MCP_TOOL_CALL_LIMITS = {
  maxConcurrentToolCalls: 100,
  maxConcurrentToolCallsPerPrincipal: 8,
  maxConcurrentWriteToolCallsPerPrincipal: 2,
  maxConcurrentExternalProviderToolCallsPerPrincipal: 2,
} as const satisfies Required<McpToolCallLimiterFromRealtimeOptions>;

export function createMcpToolCallLimiterFromRealtime(
  streamLimiter: RealtimeStreamLimiter,
  options: McpToolCallLimiterFromRealtimeOptions = {},
): McpToolCallLimiter {
  const limits: Required<McpToolCallLimiterFromRealtimeOptions> = {
    maxConcurrentToolCalls: positiveIntegerOrDefault(
      options.maxConcurrentToolCalls,
      DEFAULT_MCP_TOOL_CALL_LIMITS.maxConcurrentToolCalls,
    ),
    maxConcurrentToolCallsPerPrincipal: positiveIntegerOrDefault(
      options.maxConcurrentToolCallsPerPrincipal,
      DEFAULT_MCP_TOOL_CALL_LIMITS.maxConcurrentToolCallsPerPrincipal,
    ),
    maxConcurrentWriteToolCallsPerPrincipal: positiveIntegerOrDefault(
      options.maxConcurrentWriteToolCallsPerPrincipal,
      DEFAULT_MCP_TOOL_CALL_LIMITS.maxConcurrentWriteToolCallsPerPrincipal,
    ),
    maxConcurrentExternalProviderToolCallsPerPrincipal: positiveIntegerOrDefault(
      options.maxConcurrentExternalProviderToolCallsPerPrincipal,
      DEFAULT_MCP_TOOL_CALL_LIMITS.maxConcurrentExternalProviderToolCallsPerPrincipal,
    ),
  };

  return {
    acquire: async (request) => {
      const lease = await streamLimiter.acquire({
        connectionKey: mcpToolCallConnectionKey(request),
        maxActiveStreams: limits.maxConcurrentToolCalls,
        maxActiveStreamsPerConnectionKey: perPrincipalLimit(request.limitKind, limits),
      });

      return lease
        ? {
            allowed: true,
            lease: {
              release: lease.release,
            },
          }
        : {
            allowed: false,
            reason: "Too many MCP tool calls are already running for this principal.",
          };
    },
  };
}

function perPrincipalLimit(limitKind: McpToolCallLimitKind, limits: Required<McpToolCallLimiterFromRealtimeOptions>) {
  if (limitKind === "external-provider") {
    return limits.maxConcurrentExternalProviderToolCallsPerPrincipal;
  }

  if (limitKind === "write") {
    return limits.maxConcurrentWriteToolCallsPerPrincipal;
  }

  return limits.maxConcurrentToolCallsPerPrincipal;
}

function mcpToolCallConnectionKey(request: McpToolCallLimitRequest) {
  return [
    "mcp-tool",
    request.transport,
    request.limitKind,
    hashKey(
      [
        request.accountId ? `account:${request.accountId}` : "",
        request.actorId ? `actor:${request.actorId}` : "",
        request.grantId ? `grant:${request.grantId}` : "",
        request.agentProfileUrl ? `agent:${request.agentProfileUrl}` : "",
        request.clientAddress ? `client:${request.clientAddress}` : "",
      ]
        .filter(Boolean)
        .join("|") || "anonymous",
    ),
  ].join(":");
}

function hashKey(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function positiveIntegerOrDefault(value: number | undefined, defaultValue: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultValue;
}
