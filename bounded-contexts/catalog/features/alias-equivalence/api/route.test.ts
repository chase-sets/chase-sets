import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { catalogAliasStreamId } from "../domain/domain";
import { catalogAliasRoutes, type CatalogAliasRouteServices } from "./route";
import type { CatalogAliasReviewReadModel } from "./alias-review-admin-contracts";

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

function emptyReadModel(): CatalogAliasReviewReadModel {
  return {
    schemaVersion: "catalog-alias-review-v1",
    generatedAt: "2026-06-16T00:00:00.000Z",
    filter: {
      providerKey: null,
      sourceProfileVersion: null,
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
      targetKind: null,
      targetId: null,
    },
    counts: {
      total: 0,
      pending: 0,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: 0,
      autoAcceptEligible: 0,
      warned: 0,
    },
    candidates: [],
    groups: [],
    coverage: {
      cardsWithAcceptedEnglishAlias: 0,
      cardsWithOnlySpeciesAliases: 0,
      cardsNeedingReview: 0,
      expansionsAndSeriesNeedingReview: 0,
      cards: [],
      referenceScopes: [],
    },
  };
}

function buildApp(services: CatalogAliasRouteServices, actor: CatalogAuthoringEnv["Variables"]["actor"] = manageActor) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("/alias-review/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/alias-review", catalogAliasRoutes(services));
  return app;
}

function commandHandlerStub(reviewStatus: string) {
  return vi.fn().mockResolvedValue({
    state: { reviewStatus },
    version: 2,
    newEvents: [],
    storedEvents: [],
  });
}

describe("Catalog alias review route", () => {
  it("returns the alias review read model for catalog.view operators, scoped by the query filter", async () => {
    const getCatalogAliasReviewReadModel = vi.fn().mockResolvedValue(emptyReadModel());
    const app = buildApp(
      {
        getCatalogAliasReviewReadModel,
        catalogAliasCommandHandler: commandHandlerStub("pending"),
      },
      viewOnlyActor,
    );

    const response = await app.request("/alias-review?providerKey=tcgdex&sourceProfileVersion=2026.06.04");

    expect(response.status).toBe(200);
    expect(getCatalogAliasReviewReadModel).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          providerKey: "tcgdex",
          sourceProfileVersion: "2026.06.04",
        }),
      }),
    );
  });

  it("dispatches the #1905 AcceptCatalogAlias command per alias hash and returns the committed snapshot", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("accepted");
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", aliasHashes: "hash_a,hash_b" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { intent: string; count: number; applied: unknown[] };
    expect(body.intent).toBe("accept");
    expect(body.count).toBe(2);
    expect(catalogAliasCommandHandler).toHaveBeenCalledTimes(2);
    expect(catalogAliasCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: catalogAliasStreamId("hash_a"),
        command: { type: "AcceptCatalogAlias", actor: "usr_reviewer", reason: null },
        context,
      }),
    );
  });

  it("dispatches RejectCatalogAlias with the operator reason", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("rejected");
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "reject", aliasHashes: "hash_a", reason: "Generated, not official" }),
    });

    expect(response.status).toBe(200);
    expect(catalogAliasCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RejectCatalogAlias", actor: "usr_reviewer", reason: "Generated, not official" },
      }),
    );
  });

  it("dispatches RevokeCatalogAlias with the operator reason", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("revoked");
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "revoke", aliasHashes: "hash_a", reason: "Superseded by manual alias" }),
    });

    expect(response.status).toBe(200);
    expect(catalogAliasCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RevokeCatalogAlias", actor: "usr_reviewer", reason: "Superseded by manual alias" },
      }),
    );
  });

  it("rejects reject/revoke commands without a reason", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("pending");
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "reject", aliasHashes: "hash_a" }),
    });

    expect(response.status).toBe(400);
    expect(catalogAliasCommandHandler).not.toHaveBeenCalled();
  });

  it("rejects an unknown command intent", async () => {
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler: commandHandlerStub("pending"),
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "promote", aliasHashes: "hash_a" }),
    });

    expect(response.status).toBe(400);
  });

  it("denies review commands for catalog.view-only operators", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("pending");
    const app = buildApp(
      {
        getCatalogAliasReviewReadModel: vi.fn(),
        catalogAliasCommandHandler,
      },
      viewOnlyActor,
    );

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", aliasHashes: "hash_a" }),
    });

    expect(response.status).toBe(403);
    expect(catalogAliasCommandHandler).not.toHaveBeenCalled();
  });
});
