import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import {
  catalogAliasStreamId,
  decideCatalogAlias,
  evolveCatalogAlias,
  initialCatalogAliasState,
  type CatalogAliasState,
} from "../domain/domain";
import { buildCatalogAliasCandidate } from "../domain/alias";
import { planPromotionAliases } from "../../source-observations/api/promotion/provider-promotion-alias-planner";
import { catalogAliasRoutes, type CatalogAliasRouteServices } from "./route";
import type { CatalogAliasReviewReadModel } from "./alias-review-admin-contracts";
import type { CatalogAliasCandidateRow } from "../read-model/queries";

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

/** A pending candidate; `curated-operator-mapping` is one governance auto-accepts, so it is eligible. */
function candidateRow(overrides: Partial<CatalogAliasCandidateRow> = {}): CatalogAliasCandidateRow {
  return {
    alias_hash: "hash_a",
    target_kind: "catalog-item",
    target_id: "cat_charizard",
    target_key: "name",
    alias_text: "Sprigatito",
    normalized_alias_text: "sprigatito",
    alias_language_code: "en",
    source_language_code: "ja",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "pending",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "curated-operator-mapping",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    first_observed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function buildApp(
  services: Omit<CatalogAliasRouteServices, "getSourceObservationAliasCandidate"> &
    Partial<Pick<CatalogAliasRouteServices, "getSourceObservationAliasCandidate">>,
  actor: CatalogAuthoringEnv["Variables"]["actor"] = manageActor,
) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("/alias-review/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route(
    "/alias-review",
    catalogAliasRoutes({
      getSourceObservationAliasCandidate: vi.fn().mockResolvedValue({ target_id: "cat_resolved" }),
      ...services,
    }),
  );
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
  it.each(["accept", "reject", "revoke"])(
    "refuses %s of unresolved intake and proposed reference hashes without dispatching any event",
    async (intent) => {
      for (const kind of ["catalog-item", "reference-record"] as const) {
        const candidate = buildCatalogAliasCandidate({
          target: { kind, targetId: null, targetKey: kind === "catalog-item" ? "name" : "expansion" },
          aliasText: "Triplet Beat",
          aliasLanguageCode: "en",
          sourceLanguageCode: "ja",
          aliasType: kind === "catalog-item" ? "official-equivalent" : "set-equivalent",
          confidence: "high",
          reviewStatus: "pending",
          provenance: {
            providerKey: "tcgdex",
            observationId: "obs_1",
            sourceCategory: "provider-same-id-localized-endpoint",
            sourceProfileKey: "pokemon-tcg",
            sourceProfileVersion: "1",
            mappingFingerprint: "fp",
          },
          evidence: {},
        });
        const events =
          kind === "reference-record"
            ? [
                ...decideCatalogAlias(initialCatalogAliasState, {
                  type: "ProposeCatalogAlias",
                  candidate,
                  actor: "system",
                }),
              ]
            : [];
        let state = events.reduce(evolveCatalogAlias, initialCatalogAliasState);
        const initialEventCount = events.length;
        const catalogAliasCommandHandler: CatalogAliasRouteServices["catalogAliasCommandHandler"] = vi.fn(
          async ({ command }) => {
            const newEvents = decideCatalogAlias(state, command);
            events.push(...newEvents);
            state = newEvents.reduce(evolveCatalogAlias, state);
            return { state, version: events.length, newEvents, storedEvents: [] };
          },
        );
        const app = buildApp({
          getCatalogAliasReviewReadModel: vi.fn(),
          catalogAliasCommandHandler,
          getSourceObservationAliasCandidate: vi.fn(
            async (hash) => ({ alias_hash: hash, target_id: hash === "resolved" ? "cat_1" : null }) as never,
          ),
        });
        const response = await app.request("/alias-review/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent, aliasHashes: `resolved,${candidate.aliasHash}`, reason: "Verified" }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "alias_review_no_candidates", message: expect.any(String) },
        });
        expect(catalogAliasCommandHandler).not.toHaveBeenCalled();
        expect(events).toHaveLength(initialEventCount);
      }
    },
  );

  it("routes the executable promotion hash to one aggregate and reloads each settled state", async () => {
    const intake = buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: null, targetKey: "expansion" },
      aliasText: "Triplet Beat",
      aliasLanguageCode: "en",
      sourceLanguageCode: "ja",
      aliasType: "set-equivalent",
      confidence: "high",
      reviewStatus: "pending",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_1",
        sourceCategory: "provider-same-id-localized-endpoint",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "1",
        mappingFingerprint: "fp",
      },
      evidence: { sharedId: "sv1a" },
    });
    const plan = planPromotionAliases({
      candidates: [intake],
      resolution: { catalogItemId: "cat_1", referenceRecordIdsByTypeKey: { expansion: "ref_1" } },
    });
    const action = plan.actions[0];
    expect(action?.kind).toBe("propose");
    if (action?.kind !== "propose") throw new Error("Expected promotion proposal");
    const promoted = action.candidate;
    expect(promoted.aliasHash).not.toBe(intake.aliasHash);
    let state: CatalogAliasState = initialCatalogAliasState;
    let version = 0;
    const catalogAliasCommandHandler: CatalogAliasRouteServices["catalogAliasCommandHandler"] = vi.fn(
      async ({ streamId, command }) => {
        expect(streamId).toBe(catalogAliasStreamId(promoted.aliasHash));
        const newEvents = decideCatalogAlias(state, command);
        for (const event of newEvents) state = evolveCatalogAlias(state, event);
        version += newEvents.length;
        return { state, version, newEvents, storedEvents: [] };
      },
    );
    await catalogAliasCommandHandler({
      streamId: catalogAliasStreamId(promoted.aliasHash),
      command: { type: "ProposeCatalogAlias", candidate: promoted, actor: "system" },
      context,
    });
    const app = buildApp({
      catalogAliasCommandHandler,
      getSourceObservationAliasCandidate: vi.fn(async (hash) =>
        hash === promoted.aliasHash ? ({ target_id: state.target?.targetId } as never) : null,
      ),
      getCatalogAliasReviewReadModel: vi.fn(
        async () =>
          ({
            ...emptyReadModel(),
            candidates: [
              {
                aliasHash: state.aliasHash,
                targetId: state.target?.targetId,
                targetKind: state.target?.kind,
                reviewStatus: state.reviewStatus,
              },
            ],
          }) as never,
      ),
    });
    for (const intent of ["accept", "revoke", "accept", "reject"] as const) {
      const response = await app.request("/alias-review/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, aliasHashes: promoted.aliasHash, reason: "Reviewed evidence" }),
      });
      expect(response.status).toBe(200);
      const reload = (await (await app.request("/alias-review")).json()) as CatalogAliasReviewReadModel;
      expect(reload.candidates).toEqual([
        {
          aliasHash: promoted.aliasHash,
          targetKind: "reference-record",
          targetId: "ref_1",
          reviewStatus: intent === "accept" ? "accepted" : intent === "revoke" ? "revoked" : "rejected",
        },
      ]);
      expect(state.lastAudit?.reason).toBe("Reviewed evidence");
    }
    expect(version).toBe(5);
  });

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

  it("accepts only the eligible candidates of an eligible-only accept and reports the rest as skipped", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("accepted");
    const rows = new Map([
      ["hash_eligible", candidateRow({ alias_hash: "hash_eligible" })],
      ["hash_generated", candidateRow({ alias_hash: "hash_generated", source_category: "machine-translation" })],
      ["hash_resolved", candidateRow({ alias_hash: "hash_resolved", review_status: "accepted" })],
    ]);
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
      getSourceObservationAliasCandidate: vi.fn(async (aliasHash: string) => rows.get(aliasHash) ?? null),
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "accept",
        aliasHashes: "hash_generated,hash_eligible,hash_resolved",
        eligibleOnly: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      intent: "accept",
      applied: [{ aliasHash: "hash_eligible", reviewStatus: "accepted", version: 2 }],
      count: 1,
      skipped: [
        { aliasHash: "hash_generated", reason: "not-eligible" },
        { aliasHash: "hash_resolved", reason: "not-eligible" },
      ],
    });
    expect(catalogAliasCommandHandler).toHaveBeenCalledTimes(1);
    expect(catalogAliasCommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: catalogAliasStreamId("hash_eligible") }),
    );
  });

  it("refuses an eligible-only accept naming a candidate it cannot find, and accepts none", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("accepted");
    const rows = new Map([["hash_eligible", candidateRow({ alias_hash: "hash_eligible" })]]);
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
      getSourceObservationAliasCandidate: vi.fn(async (aliasHash: string) => rows.get(aliasHash) ?? null),
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", aliasHashes: "hash_eligible,hash_gone", eligibleOnly: true }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("alias_review_no_candidates");
    expect(catalogAliasCommandHandler).not.toHaveBeenCalled();
  });

  it("accepts every named candidate when the accept is not eligible-only", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("accepted");
    const getSourceObservationAliasCandidate = vi.fn(async (aliasHash: string) =>
      candidateRow({ alias_hash: aliasHash, source_category: "machine-translation" }),
    );
    const app = buildApp({
      getCatalogAliasReviewReadModel: vi.fn(),
      catalogAliasCommandHandler,
      getSourceObservationAliasCandidate,
    });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "accept", aliasHashes: "hash_a,hash_b", eligibleOnly: "true" }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { skipped: unknown[] }).skipped).toEqual([]);
    expect(catalogAliasCommandHandler).toHaveBeenCalledTimes(2);
  });

  it("refuses eligibleOnly on anything but an accept", async () => {
    const catalogAliasCommandHandler = commandHandlerStub("rejected");
    const app = buildApp({ getCatalogAliasReviewReadModel: vi.fn(), catalogAliasCommandHandler });

    const response = await app.request("/alias-review/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "reject", aliasHashes: "hash_a", reason: "Generated", eligibleOnly: true }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "alias_review_eligible_only_accept",
    );
    expect(catalogAliasCommandHandler).not.toHaveBeenCalled();
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
