import { describe, expect, it } from "vitest";
import { createMcpToolCallLimiterFromRealtime } from "./mcp-tool-call-limiter";
import { createInMemoryRealtimeStreamLimiter } from "./realtime-stream-limiter";

describe("MCP tool call limiter", () => {
  it("caps concurrent tool calls per principal through the realtime limiter", async () => {
    const limiter = createMcpToolCallLimiterFromRealtime(createInMemoryRealtimeStreamLimiter(), {
      maxConcurrentToolCalls: 3,
      maxConcurrentToolCallsPerPrincipal: 1,
    });

    const first = await limiter.acquire({
      transport: "native-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      actorId: "user_1",
      accountId: "account_1",
    });
    const secondSamePrincipal = await limiter.acquire({
      transport: "native-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      actorId: "user_1",
      accountId: "account_1",
    });
    const differentPrincipal = await limiter.acquire({
      transport: "native-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      actorId: "user_2",
      accountId: "account_2",
    });

    expect(first.allowed).toBe(true);
    expect(secondSamePrincipal).toEqual({
      allowed: false,
      reason: "Too many MCP tool calls are already running for this principal.",
    });
    expect(differentPrincipal.allowed).toBe(true);

    if (first.allowed) {
      await first.lease.release();
    }

    const retried = await limiter.acquire({
      transport: "native-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      actorId: "user_1",
      accountId: "account_1",
    });
    expect(retried.allowed).toBe(true);
  });

  it("uses trusted client address for anonymous MCP principals", async () => {
    const limiter = createMcpToolCallLimiterFromRealtime(createInMemoryRealtimeStreamLimiter(), {
      maxConcurrentToolCalls: 3,
      maxConcurrentToolCallsPerPrincipal: 1,
    });

    const first = await limiter.acquire({
      transport: "ucp-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      clientAddress: "198.51.100.10",
    });
    const secondSameClient = await limiter.acquire({
      transport: "ucp-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      clientAddress: "198.51.100.10",
    });
    const differentClient = await limiter.acquire({
      transport: "ucp-mcp",
      toolName: "inventory.list-import-sources",
      limitKind: "read",
      clientAddress: "198.51.100.11",
    });

    expect(first.allowed).toBe(true);
    expect(secondSameClient).toEqual({
      allowed: false,
      reason: "Too many MCP tool calls are already running for this principal.",
    });
    expect(differentClient.allowed).toBe(true);
  });
});
