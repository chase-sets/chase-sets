import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { ProviderScopeMappingServices } from "./runtime";
import { createProviderScopeMappingMcpHandlers } from "./mcp";

const operator = {
  sessionId: "sess_operator",
  tenantId: "tenant",
  userId: "user_operator",
  accountId: "account_operator",
  membershipId: "membership",
  roleKey: "platform-admin",
  permissions: ["catalog.view", "catalog.manage"],
} satisfies ResolvedActor;
const owner = { ...operator, roleKey: "owner", permissions: ["catalog.manage"] } satisfies ResolvedActor;

function services(commandHandler = vi.fn()) {
  return {
    commandHandler,
    listAcceptedMappingsByScopeRecord: vi.fn(),
    listAcceptedMappingsByProviderUnit: vi.fn(),
    getMapping: vi.fn(),
    getUnmappedScopeInbox: vi.fn(),
    getScopeCoverageMatrix: vi.fn(),
    projectors: [],
  } as unknown as ProviderScopeMappingServices;
}

describe("Provider Scope Mapping MCP handlers", () => {
  it("requires a reason for reject and revoke before calling the aggregate", async () => {
    const commandHandler = vi.fn();
    const handlers = createProviderScopeMappingMcpHandlers(services(commandHandler)).toolHandlers;
    await expect(
      handlers["catalog.review-scope-mappings"]!({
        actor: operator,
        arguments: { intent: "reject", mappingIds: ["map_1"] },
      } as never),
    ).rejects.toThrow("reason");
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("refuses an owner actor even when the actor carries catalog.manage", async () => {
    const handlers = createProviderScopeMappingMcpHandlers(services()).toolHandlers;
    await expect(
      handlers["catalog.get-scope-mapping-inbox"]!({ actor: owner, arguments: {} } as never),
    ).rejects.toThrow("catalog.manage");
  });

  it("shares the review command loop and actor context with HTTP", async () => {
    const commandHandler = vi.fn().mockResolvedValue({ state: { reviewStatus: "accepted" }, version: 2 });
    const handlers = createProviderScopeMappingMcpHandlers(services(commandHandler)).toolHandlers;
    const result = await handlers["catalog.review-scope-mappings"]!({
      actor: operator,
      arguments: { intent: "accept", mappingIds: ["map_1", "map_2"] },
    } as never);
    expect(result).toMatchObject({ intent: "accept", count: 2 });
    expect(commandHandler).toHaveBeenCalledTimes(2);
  });
});
