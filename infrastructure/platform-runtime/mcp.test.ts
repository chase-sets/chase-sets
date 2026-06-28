import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMcpRoutes, type McpAuditRecord } from "./mcp";
import type { ResolvedActor } from "./auth";

const actor: ResolvedActor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "manager",
  permissions: ["inventory.view", "payouts.request", "payouts.view"],
};

function createRequest(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id: "request_1",
    method,
    params,
  };
}

function createActorApp(resolvedActor: ResolvedActor, options: Parameters<typeof createMcpRoutes>[0] = {}) {
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", resolvedActor);
    await next();
  });
  app.route("/", createMcpRoutes(options));
  return app;
}

describe("MCP runtime routes", () => {
  it("lists only available descriptor-backed tools", async () => {
    const app = createMcpRoutes();
    const response = await app.request("/tools");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string; annotations: { availability: string } }> };
    expect(body.tools.map((tool) => tool.name).sort()).toEqual([
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.list-import-sources",
    ]);
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "inventory.list-import-sources",
          inputSchema: expect.objectContaining({ type: "object" }),
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
        expect.objectContaining({
          name: "inventory.create-import-batch",
          annotations: expect.objectContaining({
            confirmationRequired: true,
            confirmationMatchInputField: "confirmationText",
            confirmationExpectedValue: "Create Inventory Import Batch.",
          }),
        }),
      ]),
    );
  });

  it("lists only available descriptor-backed resources", async () => {
    const app = createMcpRoutes();
    const response = await app.request("/resources");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resources: [
        expect.objectContaining({
          uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
      ],
    });
  });

  it("filters JSON-RPC list methods to available capabilities", async () => {
    const app = createMcpRoutes();
    const toolsResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
    });
    const resourcesResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("resources/list")),
    });

    expect(toolsResponse.status).toBe(200);
    await expect(toolsResponse.json()).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: "inventory.list-import-sources" }),
          expect.objectContaining({ name: "inventory.create-import-batch" }),
          expect.objectContaining({ name: "inventory.get-import-batch" }),
          expect.objectContaining({ name: "inventory.commit-import-batch" }),
        ],
      },
    });
    expect(resourcesResponse.status).toBe(200);
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: [
          expect.objectContaining({
            uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          }),
        ],
      },
    });
  });

  it("calls a registered tool handler after authorization", async () => {
    const auditRecords: McpAuditRecord[] = [];
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": vi.fn(async ({ actor: resolvedActor, arguments: args }) => ({
          accountId: resolvedActor?.accountId,
          query: args.status,
          items: [],
        })),
      },
      audit: (record) => {
        auditRecords.push(record);
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
            status: "available",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      result: {
        content: [
          {
            type: "json",
            json: {
              accountId: "account_1",
              query: "available",
              items: [],
            },
          },
        ],
      },
    });
    expect(auditRecords).toEqual([
      expect.objectContaining({
        outcome: "allowed",
        method: "tools/call",
        toolName: "inventory.list-items",
        actorId: "user_1",
        accountId: "account_1",
      }),
    ]);
  });

  it("rejects missing required tool arguments before reaching handlers", async () => {
    const handler = vi.fn();
    const audit = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": handler,
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            status: "available",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32602,
        message: "Invalid MCP tool arguments.",
        data: {
          issues: [
            {
              path: "accountId",
              message: "Required field is missing.",
              expected: "present",
              actual: "missing",
            },
          ],
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "inventory.list-items",
        reason: "Invalid MCP tool arguments.",
      }),
    );
  });

  it("rejects wrong-type tool arguments before reaching handlers", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: 12,
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32602,
        message: "Invalid MCP tool arguments.",
        data: {
          issues: [
            {
              path: "accountId",
              message: "Expected string.",
              expected: "string",
              actual: "number",
            },
          ],
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects out-of-enum tool arguments before authorization", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.create-import-batch": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.create-import-batch",
          arguments: {
            accountId: "account_1",
            sourceKey: "csv",
            quantityMode: "merge",
            idempotencyKey: "idem_1",
            confirmationText: "Create Inventory Import Batch.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32602,
        message: "Invalid MCP tool arguments.",
        data: {
          issues: [
            {
              path: "quantityMode",
              message: "Expected one of: add, replace.",
              expected: "add | replace",
              actual: "merge",
            },
          ],
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects tools without the required permission and records audit", async () => {
    const audit = vi.fn();
    const app = createActorApp(
      {
        ...actor,
        permissions: ["inventory.view"],
      },
      { audit },
    );

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "Missing required permission: payouts.request.",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        toolName: "settlement.request-payout",
        reason: "Missing required permission: payouts.request.",
      }),
    );
  });

  it("rejects sensitive tools without confirmation before reaching handlers", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "Confirmation is required for this MCP tool.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive tools when confirmation text does not match the expected value", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "Confirmation text must exactly match 'Request Payout.'.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive tools with blank idempotency after schema validation", async () => {
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": vi.fn(),
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "An idempotency key is required for this MCP tool.",
      },
    });
  });

  it("returns an auditable safe boundary when no handler is registered", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32004,
        message: "No runtime handler is registered for MCP tool 'inventory.list-items'.",
        data: expect.objectContaining({
          tool: expect.objectContaining({
            name: "inventory.list-items",
          }),
          redactedArguments: {
            accountId: "account_1",
          },
        }),
      },
    });
  });

  it("returns a JSON-RPC error and failed audit when a resource handler throws", async () => {
    const audit = vi.fn();
    const app = createActorApp(actor, {
      resourceHandlers: {
        "chase-sets://inventory/{accountId}/import-batches/{batchId}": vi.fn(async () => {
          throw new Error("Import batch read failed.");
        }),
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("resources/read", {
          uri: "chase-sets://inventory/account_1/import-batches/batch_1",
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32000,
        message: "Import batch read failed.",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        method: "resources/read",
        resourceUri: "chase-sets://inventory/account_1/import-batches/batch_1",
        actorId: "user_1",
        accountId: "account_1",
        auditEventName: "mcp.inventory.resources.read",
        targetType: "Inventory Import Batch",
        reason: "Import batch read failed.",
      }),
    );
  });
});
