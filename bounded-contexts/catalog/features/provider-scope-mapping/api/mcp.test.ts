import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { contextManifest } from "../../../index";
import type { ProviderScopeMappingServices } from "./runtime";
import { createProviderScopeMappingMcpHandlers } from "./mcp";
import { createProviderScopeDiscoveryMcpHandlers } from "../../provider-scope-discovery/api/mcp";
import { createScopeRegistryMcpHandlers } from "../../scope-registry/api/mcp";
import { createReferenceDataMcpHandlers } from "../../reference-data/api/mcp";

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
    ).rejects.toThrow("catalog.view");
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

  it("pins route calls to the declared Agent Coverage tools", () => {
    expect(contextManifest.agentCoverage["scope-coverage"].tools).toEqual(["catalog.get-scope-mapping-inbox"]);
    expect(contextManifest.agentCoverage["scope-coverage-detail"].tools).toEqual([
      "catalog.get-scope-coverage",
      "catalog.review-scope-mappings",
      "catalog.propose-scope-mapping",
    ]);
    expect(contextManifest.agentCoverage["scope-landing"]).toEqual({ pending: "#9685" });
    const route = readFileSync(new URL("../../../routes/admin/scope-coverage.tsx", import.meta.url), "utf8");
    const detail = readFileSync(new URL("../../../routes/admin/scope-coverage-detail.tsx", import.meta.url), "utf8");
    const landing = readFileSync(new URL("../../../routes/admin/scope-landing.tsx", import.meta.url), "utf8");
    const landingLoader = readFileSync(
      new URL("../../../support/route-support/admin-scope-landing/scope-landing-loader.ts", import.meta.url),
      "utf8",
    );
    expect([...new Set([...landingLoader.matchAll(/api\.(\w+)/g)].map((match) => match[1]))].sort()).toEqual(
      ["getCatalogAliasReviewReadModel", "getCatalogAttentionQueueReadModel", "listCatalogScopeRecords"].sort(),
    );
    expect(landing).toMatch(/export async function action\(/);
    expect([...route.matchAll(/api\.(\w+)(?:<[^>]+>)?\(/g)].map((match) => match[1]).sort()).toEqual(
      ["getUnmappedScopeInbox"].sort(),
    );
    expect([...detail.matchAll(/api\.(\w+)(?:<[^>]+>)?\(/g)].map((match) => match[1]).sort()).toEqual([
      "getScopeCoverageMatrix",
    ]);
    const hook = readFileSync(new URL("../ui/use-provider-scope-mapping.ts", import.meta.url), "utf8");
    const hookCalls = [...hook.matchAll(/api\.(\w+)(?:<[^>]+>)?\(/g)].map((match) => match[1]);
    expect(hookCalls.filter((name) => name === "getUnmappedScopeInbox")).toHaveLength(1);
    expect(hookCalls.filter((name) => name === "proposeProviderScopeMapping")).toHaveLength(1);
    expect(hookCalls.filter((name) => name === "dispatchProviderScopeMappingReviewCommand")).toHaveLength(3);
  });

  it("keeps HTTP and MCP parsing aligned for inbox and review inputs", async () => {
    const runtime = services();
    const handler = createProviderScopeMappingMcpHandlers(runtime).toolHandlers["catalog.get-scope-mapping-inbox"]!;
    await handler({ actor: operator, arguments: { limit: "abc", productDomain: "bogus" } } as never);
    expect(runtime.getUnmappedScopeInbox).toHaveBeenCalledWith({ limit: undefined });
    await expect(
      createProviderScopeMappingMcpHandlers(services()).toolHandlers["catalog.review-scope-mappings"]!({
        actor: operator,
        arguments: { intent: "accept", mappingIds: [] },
      } as never),
    ).rejects.toThrow("provider_scope_mapping_no_candidates");
    const discovery = {
      listScopeObservations: vi.fn().mockResolvedValue([]),
      listCanonicalScopeRecordProposals: vi.fn().mockResolvedValue([]),
    };
    const dh = createProviderScopeDiscoveryMcpHandlers(discovery as never).toolHandlers;
    await dh["catalog.list-scope-observations"]!({
      actor: operator,
      arguments: { scopeKind: "bogus", limit: "abc" },
    } as never);
    expect(discovery.listScopeObservations).toHaveBeenCalledWith({
      providerKey: undefined,
      unitKey: undefined,
      scopeKind: null,
      limit: undefined,
    });
    await dh["catalog.list-scope-record-proposals"]!({
      actor: operator,
      arguments: { productDomain: "Magic", reviewStatus: "open" },
    } as never);
    expect(discovery.listCanonicalScopeRecordProposals).toHaveBeenCalledWith({
      reviewStatus: null,
      productDomain: null,
      limit: undefined,
    });
    const reference = { referenceRecordCommandHandler: vi.fn() };
    const referenceHandlers = createReferenceDataMcpHandlers(reference as never).toolHandlers;
    await expect(
      referenceHandlers["catalog.publish-reference-record"]!({
        actor: operator,
        arguments: { referenceRecordId: "not-a-ref" },
      } as never),
    ).rejects.toThrow();
  });

  it.each([["catalog.get-scope-coverage", "getScopeCoverageMatrix", { scopeRecordId: "scope_1" }]])(
    "covers %s success, missing argument, and not-found paths",
    async (name, serviceKey, args) => {
      const runtime = services();
      const service = runtime[serviceKey as "getScopeCoverageMatrix"] as ReturnType<typeof vi.fn>;
      service.mockResolvedValue({ scopeRecordId: "scope_1" });
      const handler = createProviderScopeMappingMcpHandlers(runtime).toolHandlers[name]!;
      await expect(handler({ actor: operator, arguments: args } as never)).resolves.toEqual({
        scopeRecordId: "scope_1",
      });
      await expect(handler({ actor: operator, arguments: {} } as never)).rejects.toThrow(/required/);
      service.mockResolvedValue(null);
      await expect(handler({ actor: operator, arguments: args } as never)).rejects.toThrow("not found");
    },
  );

  it("covers provider refresh tools and scope record listing handlers", async () => {
    const discovery = {
      listRefreshSchedules: vi.fn().mockResolvedValue([]),
      setRefreshPaused: vi.fn().mockResolvedValue({ providerKey: "p" }),
      runProviderRefreshNow: vi.fn().mockResolvedValue({ status: "succeeded" }),
      listScopeObservations: vi.fn().mockResolvedValue([]),
      listCanonicalScopeRecordProposals: vi.fn().mockResolvedValue([]),
    };
    const dh = createProviderScopeDiscoveryMcpHandlers(discovery as never).toolHandlers;
    await expect(
      dh["catalog.list-provider-refresh-schedules"]!({ actor: operator, arguments: {} } as never),
    ).resolves.toEqual({ items: [], total: 0, count: 0 });
    await expect(dh["catalog.pause-provider-refresh"]!({ actor: operator, arguments: {} } as never)).rejects.toThrow(
      "providerKey",
    );
    await expect(dh["catalog.resume-provider-refresh"]!({ actor: operator, arguments: {} } as never)).rejects.toThrow(
      "providerKey",
    );
    await expect(
      dh["catalog.pause-provider-refresh"]!({ actor: operator, arguments: { providerKey: "p" } } as never),
    ).resolves.toEqual({ providerKey: "p" });
    discovery.setRefreshPaused.mockResolvedValueOnce(null);
    await expect(
      dh["catalog.pause-provider-refresh"]!({ actor: operator, arguments: { providerKey: "p" } } as never),
    ).rejects.toThrow("provider_refresh_schedule_not_found");
    discovery.setRefreshPaused.mockResolvedValueOnce(null);
    await expect(
      dh["catalog.resume-provider-refresh"]!({ actor: operator, arguments: { providerKey: "p" } } as never),
    ).rejects.toThrow("provider_refresh_schedule_not_found");
    const registry = { listScopeRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }), getScopeRecord: vi.fn() };
    const rh = createScopeRegistryMcpHandlers(registry as never).toolHandlers;
    await expect(rh["catalog.list-scope-records"]!({ actor: operator, arguments: {} } as never)).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
    await expect(rh["catalog.get-scope-record"]!({ actor: operator, arguments: {} } as never)).rejects.toThrow(
      "scopeRecordId",
    );
    registry.getScopeRecord.mockResolvedValue(null);
    await expect(
      rh["catalog.get-scope-record"]!({ actor: operator, arguments: { scopeRecordId: "scope_1" } } as never),
    ).rejects.toThrow("not found");
  });
});
