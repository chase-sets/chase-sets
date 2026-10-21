import { describe, expect, it, vi } from "vitest";
import { findMcpTool, getMcpToolConfirmationExpectedValue } from "./mcp-contracts";
import { createProjectionOperationsMcpHandlers } from "./projection-operations-mcp";
import type { McpToolHandlerInput } from "./mcp";

const actor = {
  userId: "usr_operator",
  accountId: "acc_operator",
  roleKey: "platform-admin",
  permissions: ["projection-operations.view", "projection-operations.operate", "projection-operations.rebuild"],
} as McpToolHandlerInput["actor"];

function input(name: string, arguments_: Record<string, unknown>): McpToolHandlerInput {
  return {
    actor,
    tool: findMcpTool(name)!,
    arguments: arguments_,
    request: new Request("https://example.test/mcp"),
    protocol: {} as McpToolHandlerInput["protocol"],
  };
}

function runtime() {
  return {
    accountCapabilityRegistry: {},
    mountedContexts: [],
    mountedModules: [],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
}

describe("projection operations MCP handlers", () => {
  it("publishes every incident action as an available operator capability", () => {
    const names = [
      "get-snapshot",
      "get-wake-status",
      "list-blocked-streams",
      "list-operations",
      "get-operation",
      "refresh",
      "refresh-checkpoint",
      "retry-blocked-stream",
      "cancel-operation",
      "rebuild-projection-group",
      "rebuild-context",
    ];
    for (const name of names) {
      const tool = findMcpTool(`projection-operations.${name}`);
      expect(tool?.availability).toBe("available");
      expect(tool?.permissionBoundary.scope).toBe("operator");
    }
  });

  it("uses exact title confirmations and validates rebuild literals before enqueue", async () => {
    const enqueue = vi.fn(async () => ({ operationId: "op_1" }));
    const handlers = createProjectionOperationsMcpHandlers(runtime(), {
      controlPlane: { enqueueProjectionOperation: enqueue } as never,
    }).toolHandlers;
    const tool = findMcpTool("projection-operations.rebuild-context")!;
    const title = getMcpToolConfirmationExpectedValue(tool);
    expect(title).toBe("Rebuild Context.");

    await expect(
      handlers[tool.name]!(
        input(tool.name, {
          contextName: "catalog",
          confirm: "rebuild",
          idempotencyKey: "k1",
          confirmationText: title,
        }),
      ),
    ).rejects.toThrow("rebuild-all");
    expect(enqueue).not.toHaveBeenCalled();

    await handlers[tool.name]!(
      input(tool.name, {
        contextName: "catalog",
        confirm: "rebuild-all",
        idempotencyKey: "k1",
        confirmationText: title,
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationKind: "rebuild-context", contextName: "catalog" }),
    );
  });

  it("shares the control-plane enqueue payload for blocked-stream retry", async () => {
    const enqueue = vi.fn(async () => ({ operationId: "op_retry" }));
    const handlers = createProjectionOperationsMcpHandlers(runtime(), {
      controlPlane: { enqueueProjectionOperation: enqueue } as never,
    }).toolHandlers;
    await handlers["projection-operations.retry-blocked-stream"]!(
      input("projection-operations.retry-blocked-stream", {
        projectionKey: "catalog.items",
        streamId: "stream_1",
        idempotencyKey: "k2",
        confirmationText: "Retry Blocked Projection Stream.",
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "retry-blocked-stream",
        contextName: "catalog",
        projectionKey: "catalog.items",
        streamId: "stream_1",
        requestedByUserId: "usr_operator",
        requestedByAccountId: "acc_operator",
      }),
    );
  });
});
