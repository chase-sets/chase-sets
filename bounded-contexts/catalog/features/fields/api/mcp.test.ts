import type { McpToolHandlerInput } from "@chase-sets/platform-runtime/mcp";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import { expect, it, vi } from "vitest";
import { createFieldMcpHandlers } from "./mcp";
import type { FieldServices } from "./runtime";

it("MCP source-call contract coverage", async () => {
  const name = "catalog.list-fields";
  const listFields = vi.fn<FieldServices["listFields"]>().mockResolvedValue({ items: [], total: 36 });
  const handler = createFieldMcpHandlers({ listFields }).toolHandlers[name];
  const args = {
    search: "color",
    status: "active",
    limit: 10,
    offset: 20,
    valueType: "text",
    filterable: "true",
    searchable: "false",
    sortable: "true",
  };
  const call = {
    actor: {
      roleKey: "platform-admin",
      permissions: ["catalog.view"],
      accountId: "operator",
      userId: "operator",
      sessionId: "session",
      tenantId: "tenant",
      membershipId: "membership",
    },
    arguments: args,
    tool: findMcpTool(name)!,
    request: new Request("https://example.test/mcp"),
    protocol: { protocolVersion: "2025-11-25", stateless: true, clientInfo: null, clientCapabilities: null },
  } satisfies McpToolHandlerInput;
  expect(await handler(call)).toEqual({ items: [], total: 36, count: 0 });
  expect(listFields).toHaveBeenCalledWith(args);
  await expect(handler({ ...call, actor: { ...call.actor, roleKey: "owner" } })).rejects.toThrow("catalog.view");
  await expect(handler({ ...call, arguments: { ...args, accountId: "other" } })).rejects.toThrow();
  expect(listFields).toHaveBeenCalledTimes(1);
});
