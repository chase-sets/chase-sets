import type { McpToolHandlerInput } from "@chase-sets/platform-runtime/mcp";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import { expect, it, vi } from "vitest";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { createReferenceDataMcpHandlers } from "./mcp";
import type { ReferenceDataServices } from "./runtime";

it("MCP source-call contract coverage", async () => {
  const name = "catalog.list-reference-records";
  const services = createCatalogServices({
    query: async () => {
      throw new Error("Unexpected database query in Reference Record MCP test.");
    },
    connect: async () => {
      throw new Error("Unexpected database connection in Reference Record MCP test.");
    },
  });
  const listReferenceRecords = vi
    .fn<ReferenceDataServices["listReferenceRecords"]>()
    .mockResolvedValue({ items: [], total: 35 });
  const handler = createReferenceDataMcpHandlers({ ...services.referenceData, listReferenceRecords }).toolHandlers[
    name
  ]!;
  const args = {
    search: "set",
    status: "active",
    limit: 10,
    offset: 20,
    typeKey: "set",
    relationshipType: "belongs-to",
    relatedReferenceId: "reference",
    attributeKey: "code",
    attributeValue: "SET",
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
  expect(await handler(call)).toEqual({ items: [], total: 35, count: 0 });
  expect(listReferenceRecords).toHaveBeenCalledWith(args);
  await expect(handler({ ...call, actor: { ...call.actor, permissions: [] } })).rejects.toThrow("catalog.view");
  await expect(handler({ ...call, arguments: { ...args, attributeValue: true } })).rejects.toThrow();
  expect(listReferenceRecords).toHaveBeenCalledTimes(1);
});
