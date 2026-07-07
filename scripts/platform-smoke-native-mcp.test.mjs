import { describe, expect, it } from "vitest";
import {
  isNativeMcpAnonymousDiscoveryRejected,
  isNativeMcpPermissionBoundaryError,
  isNativeMcpPermissionBoundaryResult,
  nativeMcpHeadersForRevision,
  nativeMcpJsonRpcRequestForRevision,
  nativeMcpProtocolMatrix,
  readNativeMcpToolTextMessages,
  readNativeMcpToolStructuredContent,
  shouldInitializeNativeMcpRevision,
  summarizeNativeMcpImportSourceKeys,
} from "./platform-smoke-native-mcp.mjs";

function responseWithStatus(status) {
  return { status };
}

describe("native MCP platform smoke", () => {
  it("accepts safe anonymous discovery rejection statuses", () => {
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(401))).toBe(true);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(403))).toBe(true);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(405))).toBe(true);
  });

  it("rejects success and missing-route responses", () => {
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(200))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(204))).toBe(false);
    expect(isNativeMcpAnonymousDiscoveryRejected(responseWithStatus(404))).toBe(false);
  });

  it("recognizes the authenticated inventory permission boundary", () => {
    expect(
      isNativeMcpPermissionBoundaryError({ message: "Missing required permission: inventory.view." }, "inventory.view"),
    ).toBe(true);
    expect(
      isNativeMcpPermissionBoundaryError({ message: "Missing required permission: inventory.edit." }, "inventory.view"),
    ).toBe(false);
    expect(isNativeMcpPermissionBoundaryError({ message: "Method not found." }, "inventory.view")).toBe(false);
  });

  it("recognizes permission boundaries returned as MCP tool results", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "Missing required permission: inventory.view." }],
    };

    expect(readNativeMcpToolTextMessages(result)).toEqual(["Missing required permission: inventory.view."]);
    expect(isNativeMcpPermissionBoundaryResult(result, "inventory.view")).toBe(true);
    expect(isNativeMcpPermissionBoundaryResult({ ...result, isError: false }, "inventory.view")).toBe(false);
    expect(isNativeMcpPermissionBoundaryResult(result, "inventory.edit")).toBe(false);
  });

  it("reads native MCP tool structuredContent with a text JSON fallback", () => {
    expect(
      readNativeMcpToolStructuredContent({
        structuredContent: { items: [{ sourceKey: "tcgplayer-csv" }] },
        content: [{ type: "text", text: '{"items":[]}' }],
      }),
    ).toEqual({ items: [{ sourceKey: "tcgplayer-csv" }] });
    expect(
      readNativeMcpToolStructuredContent({
        content: [{ type: "text", text: '{"items":[{"sourceKey":"tcgplayer-csv"}]}' }],
      }),
    ).toEqual({ items: [{ sourceKey: "tcgplayer-csv" }] });
    expect(readNativeMcpToolStructuredContent({ content: [{ type: "json", json: { items: [] } }] })).toBeNull();
  });

  it("summarizes import source keys for deploy smoke diagnostics", () => {
    expect(
      summarizeNativeMcpImportSourceKeys({
        structuredContent: { items: [{ sourceKey: "shopify-csv" }, { sourceKey: "tcgplayer-csv" }] },
      }),
    ).toEqual({
      hasExpectedSource: true,
      sourceKeys: ["shopify-csv", "tcgplayer-csv"],
      diagnostic: "Native MCP import source keys: shopify-csv, tcgplayer-csv.",
    });
    expect(
      summarizeNativeMcpImportSourceKeys({
        structuredContent: { items: [{ sourceKey: "native-csv" }] },
      }),
    ).toEqual({
      hasExpectedSource: false,
      sourceKeys: ["native-csv"],
      diagnostic: "Native MCP import source keys: native-csv.",
    });
    expect(summarizeNativeMcpImportSourceKeys({ structuredContent: { total: 0 } })).toEqual({
      hasExpectedSource: false,
      sourceKeys: [],
      diagnostic: "Native MCP import source result did not expose an items array. Structured keys: total.",
    });
  });

  it("builds native MCP revision-specific smoke requests", () => {
    expect(nativeMcpProtocolMatrix).toEqual(["2025-06-18", "2025-11-25", "2026-07-28"]);
    expect(shouldInitializeNativeMcpRevision("2025-06-18")).toBe(true);
    expect(shouldInitializeNativeMcpRevision("2025-11-25")).toBe(true);
    expect(shouldInitializeNativeMcpRevision("2026-07-28")).toBe(false);

    expect(nativeMcpHeadersForRevision("2025-06-18", "tools/list")).toEqual({
      "Content-Type": "application/json",
    });
    expect(nativeMcpHeadersForRevision("2025-11-25", "tools/list")).toEqual({
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    });
    expect(nativeMcpHeadersForRevision("2026-07-28", "tools/call", "inventory.list-import-sources")).toEqual({
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "inventory.list-import-sources",
    });

    expect(
      nativeMcpJsonRpcRequestForRevision("2026-07-28", "list-import-sources", "tools/call", {
        name: "inventory.list-import-sources",
        arguments: { accountId: "account_1" },
      }),
    ).toMatchObject({
      jsonrpc: "2.0",
      id: "list-import-sources",
      method: "tools/call",
      params: {
        name: "inventory.list-import-sources",
        arguments: { accountId: "account_1" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "platform-smoke",
            version: "0.1.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  });
});
