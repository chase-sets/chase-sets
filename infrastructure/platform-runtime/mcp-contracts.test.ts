import { describe, expect, it } from "vitest";
import {
  CORE_MCP_SERVICE_IDS,
  EXTERNAL_MCP_SERVICE_IDS,
  authorizeMcpToolInvocation,
  findMcpTool,
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  flattenMcpTools,
  getMcpToolConfirmationExpectedValue,
  mcpServiceCatalog,
  validateMcpServiceCatalog,
  type McpActor,
  type McpServiceDescriptor,
} from "./mcp-contracts";

const accountActor: McpActor = {
  actorId: "actor_1",
  accountId: "acct_1",
  permissions: [
    "accounts.view",
    "fulfillment.manage",
    "fulfillment.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "orders.manage",
    "orders.view",
    "payouts.request",
    "payouts.view",
  ],
};

describe("MCP service catalog", () => {
  it("covers every core context and external provider that needs agent access", () => {
    expect(validateMcpServiceCatalog()).toEqual([]);
    expect(mcpServiceCatalog.map((service) => service.serviceId).sort()).toEqual(
      [...CORE_MCP_SERVICE_IDS, ...EXTERNAL_MCP_SERVICE_IDS].sort(),
    );
  });

  it("defines auditable schemas for all tools", () => {
    expect(flattenMcpTools().length).toBeGreaterThan(mcpServiceCatalog.length);

    for (const tool of flattenMcpTools()) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.audit.eventName).toMatch(/^mcp\./);
      expect(tool.audit.targetType.length).toBeGreaterThan(0);
      expect(tool.expectedUsage.length).toBeGreaterThan(0);
    }
  });

  it("marks only registered native MCP v1 capabilities as available", () => {
    expect(
      flattenAvailableMcpTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.list-import-sources",
    ]);
    expect(
      flattenAvailableMcpResources()
        .map((resource) => resource.uriTemplate)
        .sort(),
    ).toEqual(["chase-sets://inventory/{accountId}/import-batches/{batchId}"]);
    expect(flattenMcpTools().find((tool) => tool.name === "inventory.list-items")?.availability).toBe("planned");
  });

  it("requires confirmation and idempotency for sensitive and destructive tools", () => {
    const writeTools = flattenMcpTools().filter((tool) => tool.risk !== "read");

    expect(writeTools.length).toBeGreaterThan(0);
    expect(
      writeTools.every(
        (tool) =>
          tool.guardrails.confirmation.required &&
          tool.guardrails.idempotencyKey === "required" &&
          tool.permissionBoundary.requiredPermissions.length > 0,
      ),
    ).toBe(true);
  });

  it("classifies PII and financial write inputs as sensitive for redaction", () => {
    expect(findMcpTool("identity.invite-member")?.audit.sensitiveInputFields).toEqual(["confirmationText", "email"]);
    expect(findMcpTool("payments.request-refund")?.audit.sensitiveInputFields).toEqual([
      "amount",
      "confirmationText",
      "reason",
    ]);
    expect(findMcpTool("settlement.request-payout")?.audit.sensitiveInputFields).toEqual([
      "amount",
      "confirmationText",
      "reason",
    ]);
    expect(findMcpTool("fulfillment.void-label")?.audit.sensitiveInputFields).toEqual(["confirmationText", "reason"]);
  });
});

describe("MCP tool authorization", () => {
  it("allows a read tool when the actor has the required permission", () => {
    const tool = findMcpTool("inventory.list-items");

    expect(tool).not.toBeNull();
    expect(authorizeMcpToolInvocation(tool!, accountActor)).toEqual({
      allowed: true,
    });
  });

  it("rejects missing permissions", () => {
    const tool = findMcpTool("marketplace.accept-offer");

    expect(tool).not.toBeNull();
    expect(
      authorizeMcpToolInvocation(tool!, {
        actorId: "actor_2",
        accountId: "acct_1",
        permissions: ["offers.view"],
      }),
    ).toEqual({
      allowed: false,
      reason: "Missing required permission: offers.manage.",
    });
  });

  it("rejects sensitive tools without confirmation", () => {
    const tool = findMcpTool("settlement.request-payout");

    expect(tool).not.toBeNull();
    expect(authorizeMcpToolInvocation(tool!, accountActor)).toEqual({
      allowed: false,
      reason: "Confirmation is required for this MCP tool.",
    });
  });

  it.each([
    {
      toolName: "settlement.request-payout",
      expectedValue: "Request Payout.",
      input: {
        accountId: "acct_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_payout_1",
      },
    },
    {
      toolName: "fulfillment.void-label",
      expectedValue: "Void Label.",
      input: {
        accountId: "acct_1",
        shipmentId: "ship_1",
        reason: "Unused label should be voided.",
        idempotencyKey: "idem_void_1",
      },
    },
  ])("requires $toolName confirmation text to match the expected value", ({ toolName, expectedValue, input }) => {
    const tool = findMcpTool(toolName);

    expect(tool).not.toBeNull();
    expect(getMcpToolConfirmationExpectedValue(tool!)).toBe(expectedValue);

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: null,
        },
        input,
      ),
    ).toEqual({
      allowed: false,
      reason: "Confirmation text is required for this MCP tool.",
    });

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: "Confirmed by policy.",
        },
        {
          ...input,
          confirmationText: "Confirmed by policy.",
        },
      ),
    ).toEqual({
      allowed: false,
      reason: `Confirmation text must exactly match '${expectedValue}'.`,
    });

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: expectedValue,
        },
        {
          ...input,
          confirmationText: expectedValue,
        },
      ),
    ).toEqual({
      allowed: true,
    });
  });

  it("rejects account-scoped tools when the actor lacks an account scope", () => {
    const tool = findMcpTool("checkout.get-cart");

    expect(tool).not.toBeNull();
    expect(
      authorizeMcpToolInvocation(tool!, {
        actorId: "actor_3",
        accountId: null,
        permissions: ["orders.view"],
      }),
    ).toEqual({
      allowed: false,
      reason: "An account-scoped actor is required.",
    });
  });

  it("reports invalid catalogs for missing services and unguarded writes", () => {
    const invalidCatalog: readonly McpServiceDescriptor[] = [
      {
        serviceId: "inventory",
        serviceName: "Inventory",
        kind: "bounded-context",
        owner: "bounded-contexts/inventory",
        serviceBoundary: "Invalid test descriptor.",
        tools: [
          {
            name: "inventory.adjust-item",
            title: "Adjust Item",
            description: "Invalid test tool.",
            serviceId: "inventory",
            risk: "sensitive",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
            },
            permissionBoundary: {
              scope: "account",
              requiredPermissions: [],
              accountScoped: true,
              auditPrincipal: "actor",
            },
            guardrails: {
              confirmation: {
                required: false,
              },
              idempotencyKey: "recommended",
              dryRunSupported: false,
              notes: [],
            },
            audit: {
              eventName: "mcp.inventory.adjust-item",
              targetType: "inventory-item",
              sensitiveInputFields: [],
            },
            expectedUsage: ["Invalid test usage."],
          },
        ],
        resources: [],
      },
    ];

    expect(validateMcpServiceCatalog(invalidCatalog, ["inventory", "payments"])).toEqual([
      "Missing MCP service descriptor for 'payments'.",
      "inventory.adjust-item must declare at least one required permission.",
      "inventory.adjust-item must require confirmation.",
      "inventory.adjust-item must require an idempotency key.",
    ]);
  });
});
