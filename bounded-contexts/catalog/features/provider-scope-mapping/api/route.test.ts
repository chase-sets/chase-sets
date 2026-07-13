import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX } from "../domain/domain";
import { providerScopeMappingRoutes } from "./route";
import type { ProviderScopeMappingServices } from "./runtime";
import type { UnmappedScopeInboxReadModel, ScopeCoverageMatrix } from "./scope-coverage-admin-contracts";

const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_reviewer" as UserId,
    forAccountId: "acc_test" as AccountId,
  },
};

const manageActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view", "catalog.manage"],
};
const viewOnlyActor: CatalogAuthoringEnv["Variables"]["actor"] = {
  permissions: ["catalog.view"],
};

function emptyInbox(): UnmappedScopeInboxReadModel {
  return {
    schemaVersion: "catalog-scope-coverage-v1",
    generatedAt: "2026-07-13T00:00:00.000Z",
    groups: [],
    counts: { totalGroups: 0, totalCandidates: 0, highConfidenceCandidates: 0 },
  };
}

function emptyMatrix(scopeRecordId: string): ScopeCoverageMatrix {
  return {
    schemaVersion: "catalog-scope-coverage-v1",
    generatedAt: "2026-07-13T00:00:00.000Z",
    scopeRecordId,
    scopeName: "Paldean Fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    officialSetCode: "PAF",
    releaseDate: "2024-01-26",
    lifecycleStatus: "active",
    providers: [],
  };
}

function servicesStub(overrides: Partial<ProviderScopeMappingServices> = {}): ProviderScopeMappingServices {
  return {
    commandHandler: commandHandlerStub("proposed"),
    listAcceptedMappingsByScopeRecord: vi.fn().mockResolvedValue([]),
    listAcceptedMappingsByProviderUnit: vi.fn().mockResolvedValue([]),
    getMapping: vi.fn().mockResolvedValue(null),
    getUnmappedScopeInbox: vi.fn().mockResolvedValue(emptyInbox()),
    getScopeCoverageMatrix: vi.fn().mockResolvedValue(emptyMatrix("ref_expansion_paldean_fates")),
    projectors: [],
    ...overrides,
  };
}

function commandHandlerStub(reviewStatus: string) {
  return vi.fn().mockResolvedValue({
    state: { reviewStatus },
    version: 2,
    newEvents: [],
    storedEvents: [],
  });
}

function buildApp(
  services: ProviderScopeMappingServices,
  actor: CatalogAuthoringEnv["Variables"]["actor"] = manageActor,
) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("/provider-scope-mappings/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/provider-scope-mappings", providerScopeMappingRoutes(services));
  return app;
}

describe("Provider Scope Mapping review route", () => {
  it("returns the unmapped-scope inbox for catalog.view operators", async () => {
    const getUnmappedScopeInbox = vi.fn().mockResolvedValue(emptyInbox());
    const app = buildApp(servicesStub({ getUnmappedScopeInbox }), viewOnlyActor);

    const response = await app.request("/provider-scope-mappings/inbox?limit=25");

    expect(response.status).toBe(200);
    expect(getUnmappedScopeInbox).toHaveBeenCalledWith({ limit: 25 });
  });

  it("returns 404 when the coverage matrix scope record does not exist", async () => {
    const getScopeCoverageMatrix = vi.fn().mockResolvedValue(null);
    const app = buildApp(servicesStub({ getScopeCoverageMatrix }), viewOnlyActor);

    const response = await app.request("/provider-scope-mappings/coverage/ref_missing");

    expect(response.status).toBe(404);
  });

  it("returns the coverage matrix for a known scope record", async () => {
    const matrix = emptyMatrix("ref_expansion_paldean_fates");
    const getScopeCoverageMatrix = vi.fn().mockResolvedValue(matrix);
    const app = buildApp(servicesStub({ getScopeCoverageMatrix }), viewOnlyActor);

    const response = await app.request("/provider-scope-mappings/coverage/ref_expansion_paldean_fates");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(matrix);
  });

  it("dispatches AcceptProviderScopeMapping per mapping id and returns the committed snapshot", async () => {
    const commandHandler = commandHandlerStub("accepted");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", mappingIds: ["map_a", "map_b"] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { intent: string; count: number };
    expect(body.intent).toBe("accept");
    expect(body.count).toBe(2);
    expect(commandHandler).toHaveBeenCalledTimes(2);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}map_a`,
        command: { type: "AcceptProviderScopeMapping", actor: "usr_reviewer", reason: null },
        context,
      }),
    );
  });

  it("dispatches RejectProviderScopeMapping with the operator reason", async () => {
    const commandHandler = commandHandlerStub("rejected");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "reject", mappingIds: ["map_a"], reason: "Wrong expansion" }),
    });

    expect(response.status).toBe(200);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RejectProviderScopeMapping", actor: "usr_reviewer", reason: "Wrong expansion" },
      }),
    );
  });

  it("dispatches RevokeProviderScopeMapping with the operator reason", async () => {
    const commandHandler = commandHandlerStub("revoked");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "revoke", mappingIds: ["map_a"], reason: "Provider retired the set" }),
    });

    expect(response.status).toBe(200);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RevokeProviderScopeMapping", actor: "usr_reviewer", reason: "Provider retired the set" },
      }),
    );
  });

  it("rejects a reject command without a reason", async () => {
    const commandHandler = commandHandlerStub("proposed");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "reject", mappingIds: ["map_a"] }),
    });

    expect(response.status).toBe(400);
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("rejects an unknown command intent", async () => {
    const app = buildApp(servicesStub());

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "promote", mappingIds: ["map_a"] }),
    });

    expect(response.status).toBe(400);
  });

  it("denies review commands for catalog.view-only operators", async () => {
    const commandHandler = commandHandlerStub("proposed");
    const app = buildApp(servicesStub({ commandHandler }), viewOnlyActor);

    const response = await app.request("/provider-scope-mappings/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", mappingIds: ["map_a"] }),
    });

    expect(response.status).toBe(403);
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("proposes a manual mapping and leaves it pending review by default", async () => {
    const commandHandler = commandHandlerStub("proposed");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopeRecordId: "ref_expansion_paldean_fates",
        providerKey: "tcgdex",
        unitKey: "pokemon-card-import",
        coordinates: { setId: "sv4-5", setName: "Paldean Fates" },
      }),
    });

    expect(response.status).toBe(201);
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "ProposeProviderScopeMapping", actor: "usr_reviewer" }),
      }),
    );
  });

  it("proposes and immediately accepts a manual mapping when autoAccept is set", async () => {
    const commandHandler = vi
      .fn()
      .mockResolvedValueOnce({ state: { reviewStatus: "proposed" }, version: 1, newEvents: [], storedEvents: [] })
      .mockResolvedValueOnce({ state: { reviewStatus: "accepted" }, version: 2, newEvents: [], storedEvents: [] });
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopeRecordId: "ref_expansion_paldean_fates",
        providerKey: "tcgdex",
        unitKey: "pokemon-card-import",
        coordinates: { setId: "sv4-5" },
        autoAccept: true,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { reviewStatus: string };
    expect(body.reviewStatus).toBe("accepted");
    expect(commandHandler).toHaveBeenCalledTimes(2);
    expect(commandHandler.mock.calls[1][0]).toEqual(
      expect.objectContaining({ command: expect.objectContaining({ type: "AcceptProviderScopeMapping" }) }),
    );
  });

  it("rejects a manual proposal missing required fields", async () => {
    const commandHandler = commandHandlerStub("proposed");
    const app = buildApp(servicesStub({ commandHandler }));

    const response = await app.request("/provider-scope-mappings/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeRecordId: "ref_expansion_paldean_fates" }),
    });

    expect(response.status).toBe(400);
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("denies manual proposals for catalog.view-only operators", async () => {
    const commandHandler = commandHandlerStub("proposed");
    const app = buildApp(servicesStub({ commandHandler }), viewOnlyActor);

    const response = await app.request("/provider-scope-mappings/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopeRecordId: "ref_expansion_paldean_fates",
        providerKey: "tcgdex",
        unitKey: "pokemon-card-import",
        coordinates: { setId: "sv4-5" },
      }),
    });

    expect(response.status).toBe(403);
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
