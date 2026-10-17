import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ResolvedActor } from "./auth";
import { createMcpRoutes, type McpToolHandler } from "./mcp";
import type { McpServiceDescriptor } from "./mcp-contracts";
import {
  arrayProperty,
  integerProperty,
  nullableProperty,
  objectSchema,
  stringProperty,
} from "./mcp-contracts/builders";

const TOOL_NAME = "inventory.nullable-probe";

const actor: ResolvedActor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "manager",
  permissions: ["inventory.view"],
};

const services: readonly McpServiceDescriptor[] = [
  {
    serviceId: "inventory",
    serviceName: "Inventory",
    kind: "bounded-context",
    owner: "bounded-contexts/inventory",
    serviceBoundary: "Synthetic nullable-input catalog.",
    tools: [
      {
        name: TOOL_NAME,
        title: "Nullable Probe",
        description: "Synthetic read tool whose inputs mix nullable and non-nullable properties.",
        availability: "available",
        serviceId: "inventory",
        risk: "read",
        inputSchema: objectSchema(
          {
            threshold: nullableProperty({ type: "number", description: "Required; null means no threshold." }),
            note: nullableProperty({ type: "string", description: "Optional note." }),
            reference: nullableProperty({
              type: "object",
              description: "Support-request reference or null.",
              additionalProperties: false,
              required: ["kind", "supportRequestId"],
              properties: {
                kind: stringProperty("Reference kind.", ["support-request"]),
                supportRequestId: stringProperty("Support request identifier."),
              },
            }),
            tags: nullableProperty({
              type: "array",
              description: "Optional tags.",
              items: stringProperty("Tag.", ["a", "b"]),
            }),
            count: integerProperty("Non-nullable count."),
            mode: stringProperty("Non-nullable mode.", ["fast", "slow"]),
            labels: arrayProperty("Non-nullable labels.", stringProperty("Label.")),
          },
          ["threshold"],
        ),
        permissionBoundary: {
          scope: "account",
          requiredPermissions: ["inventory.view"],
          accountScoped: true,
          auditPrincipal: "actor",
        },
        guardrails: {
          confirmation: { required: false },
          idempotencyKey: "not-applicable",
          dryRunSupported: false,
          notes: [],
        },
        audit: {
          eventName: "mcp.inventory.nullable-probe",
          targetType: "nullable-probe",
          sensitiveInputFields: [],
        },
        expectedUsage: ["Synthetic nullable-input validation."],
      },
    ],
    resources: [],
  },
];

function createApp(handler: McpToolHandler) {
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", createMcpRoutes({ services, toolHandlers: { [TOOL_NAME]: handler } }));
  return app;
}

async function rpc(method: string, params: unknown) {
  const handler = vi.fn(({ arguments: args }: Parameters<McpToolHandler>[0]) => ({ received: args }));
  const response = await createApp(handler).request("/", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: "request_1", method, params }),
  });
  expect(response.status).toBe(200);
  return { handler, body: (await response.json()) as { result: Record<string, unknown> } };
}

const callTool = (args: Readonly<Record<string, unknown>>) => rpc("tools/call", { name: TOOL_NAME, arguments: args });

function argumentError(details: string) {
  return {
    isError: true,
    content: [{ type: "text", text: `Invalid MCP tool arguments. ${details}` }],
  };
}

describe("nullable MCP tool inputs at the tools/call boundary", () => {
  it("publishes the nullable tuple unchanged through tools/list", async () => {
    const { body } = await rpc("tools/list", {});
    const [tool] = body.result.tools as Array<{ inputSchema: McpServiceDescriptor["tools"][number]["inputSchema"] }>;

    expect(tool?.inputSchema.required).toEqual(["threshold"]);
    expect(tool?.inputSchema.properties.threshold?.type).toEqual(["number", "null"]);
    expect(tool?.inputSchema.properties.reference?.type).toEqual(["object", "null"]);
    expect(tool?.inputSchema.properties.count?.type).toBe("integer");
  });

  it("accepts null for every nullable property, including a required one", async () => {
    const args = { threshold: null, note: null, reference: null, tags: null };
    const { handler, body } = await callTool(args);

    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({ received: args });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts valid non-null values for nullable properties", async () => {
    const args = {
      threshold: 25.5,
      note: "Hold for review.",
      reference: { kind: "support-request", supportRequestId: "sr_1" },
      tags: ["a", "b"],
    };
    const { handler, body } = await callTool(args);

    expect(body.result.structuredContent).toEqual({ received: args });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("requires a required nullable property to be present", async () => {
    const { handler, body } = await callTool({ note: null });

    expect(body.result).toEqual(
      argumentError("threshold: Required field is missing. Expected present. Actual missing."),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong primitive",
      { threshold: "25" },
      "threshold: Expected number or null. Expected number or null. Actual string.",
    ],
    [
      "nested unknown key",
      { threshold: null, reference: { kind: "support-request", supportRequestId: "sr_1", extra: true } },
      "reference.extra: Unexpected field.",
    ],
    [
      "nested missing required key",
      { threshold: null, reference: { kind: "support-request" } },
      "reference.supportRequestId: Required field is missing. Expected present. Actual missing.",
    ],
    [
      "nested enum",
      { threshold: null, reference: { kind: "refund", supportRequestId: "sr_1" } },
      "reference.kind: Expected one of: support-request. Expected support-request. Actual refund.",
    ],
    ["item enum", { threshold: null, tags: ["a", "c"] }, "tags[1]: Expected one of: a, b. Expected a | b. Actual c."],
    ["null item", { threshold: null, tags: [null] }, "tags[0]: Expected string. Expected string. Actual null."],
  ])("keeps the non-null rules for nullable properties: %s", async (_label, args, details) => {
    const { handler, body } = await callTool(args);

    expect(body.result).toEqual(argumentError(details));
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["integer", { threshold: null, count: null }, "count: Expected integer. Expected integer. Actual null."],
    ["enum string", { threshold: null, mode: null }, "mode: Expected string. Expected string. Actual null."],
    ["array", { threshold: null, labels: null }, "labels: Expected array. Expected array. Actual null."],
  ])("still rejects null for a non-nullable %s property", async (_label, args, details) => {
    const { handler, body } = await callTool(args);

    expect(body.result).toEqual(argumentError(details));
    expect(handler).not.toHaveBeenCalled();
  });
});
