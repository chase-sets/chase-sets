import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createRecoveredItemMcpHandlers } from "./mcp";
import type { RecoveredItemServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: null,
  membershipId: null,
  roleKey: "platform-admin",
  permissions: ["recovered-inventory.view", "recovered-inventory.manage"],
} satisfies ResolvedActor;

function services(): RecoveredItemServices {
  return {
    commandHandler: vi.fn(),
    createFromFacilityIntake: vi.fn(),
    execute: vi.fn(async (recoveredItemId, _command, _context) => ({
      recoveredItemId,
      version: 4,
      state: { status: "inspection-complete" },
    })),
    list: vi.fn(async () => ({ items: [{ recovered_item_id: "rcv_1" }], total: 1 })),
    get: vi.fn(),
    metrics: vi.fn(async () => ({ total_count: 1, sellable_count: 0 })),
    projectors: [],
  } as unknown as RecoveredItemServices;
}

describe("recovered item MCP handlers", () => {
  it("MCP source-call contract coverage lists and reads operator metrics", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);

    await expect(
      handlers.toolHandlers["inventory.list-recovered-items"]!({ actor, arguments: {} } as never),
    ).resolves.toEqual({
      items: [{ recovered_item_id: "rcv_1" }],
      total: 1,
      count: 1,
    });
    await expect(
      handlers.toolHandlers["inventory.get-recovered-item-metrics"]!({ actor, arguments: {} } as never),
    ).resolves.toEqual({
      total_count: 1,
      sellable_count: 0,
    });
    expect(fake.list).toHaveBeenCalledWith({ status: null, limit: 50, offset: 0 });
  });

  it("preserves operator attribution for every delegated write", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);

    await handlers.toolHandlers["inventory.identify-recovered-item"]!({
      actor,
      arguments: {
        id: "rcv_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        evidenceReferences: ["evidence_1"],
        occurredAt: "2026-10-16T12:00:00.000Z",
      },
    } as never);

    const [id, command, context] = vi.mocked(fake.execute).mock.calls[0]!;
    expect(id).toBe("rcv_1");
    expect(command).toMatchObject({
      type: "IdentifyRecoveredItem",
      catalogItemId: "cat_1",
      identifiedByUserId: "user_1",
      evidenceReferences: ["evidence_1"],
    });
    expect(context.audit).toMatchObject({ performedByUserId: "user_1" });
  });

  it("rejects unauthorized actors and malformed action input before execution", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);
    const unauthorized = { ...actor, permissions: ["recovered-inventory.view"] } satisfies ResolvedActor;

    await expect(
      handlers.toolHandlers["inventory.merge-recovered-item"]!({
        actor: unauthorized,
        arguments: { id: "rcv_1", canonicalRecoveredItemId: "rcv_2", reason: "duplicate", evidenceReferences: ["e"] },
      } as never),
    ).rejects.toThrow("recovered-inventory.manage");
    await expect(
      handlers.toolHandlers["inventory.identify-recovered-item"]!({ actor, arguments: { id: "rcv_1" } } as never),
    ).rejects.toThrow("catalogItemId is required");
    expect(fake.execute).not.toHaveBeenCalled();
  });
});
