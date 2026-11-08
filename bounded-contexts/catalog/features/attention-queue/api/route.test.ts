import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { catalogAttentionDismissalStreamId } from "../domain/dismissal";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import { CATALOG_ATTENTION_SUMMARY_WINDOW, type CatalogAttentionQueueWindow } from "../read-model/attention-item";
import { catalogAttentionQueueRoutes, type CatalogAttentionQueueRouteServices } from "./route";
import {
  assembleCatalogAttentionQueue,
  type CatalogAttentionQueueReadModel,
  type CatalogAttentionQueueSources,
} from "./contracts";
import { catalogAttentionQueueReadModelFixture } from "./attention-queue-test-fixtures";

const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_reviewer" as UserId,
    forAccountId: "acc_test" as AccountId,
  },
};

const manageActor: CatalogAuthoringEnv["Variables"]["actor"] = { permissions: ["catalog.view", "catalog.manage"] };
const viewOnlyActor: CatalogAuthoringEnv["Variables"]["actor"] = { permissions: ["catalog.view"] };

function emptyReadModel(): CatalogAttentionQueueReadModel {
  return catalogAttentionQueueReadModelFixture([], "2026-07-09T00:00:00.000Z");
}

const COHORT_GENERATED_AT = "2026-07-09T12:00:00.000Z";

// A blocked unit becomes one critical provider-health item observed at the
// generation time, so every item of a cohort ties on severity and age and only
// the item key orders it.
function blockedUnit(index: number): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey: `unit-${String(index).padStart(4, "0")}`,
    providerKey: "tcgdex",
    displayName: `Unit ${index}`,
    productDomain: "pokemon",
    productForm: "sealed",
    ingestionPurpose: null,
    profileVersion: "v1",
    semanticReadiness: "ready",
    credentialReadiness: "blocked",
    credentialReadinessState: "expired",
    credentialRequirement: "required",
    credentialDiagnosticCode: "cred.expired",
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 1 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

// An unchanged in-memory cohort of `size` tied provider-health items behind the
// real route and assembler; the database kinds are empty and exact.
function cohortServices(size: number): CatalogAttentionQueueRouteServices {
  const sources: CatalogAttentionQueueSources = {
    proposedScopeMappings: { total: 0, rows: [] },
    mergeCandidates: { conflictTotal: 0, staleTotal: 0, rows: [] },
    // Reversed so the queue order comes from the sort, not the input order.
    unitReadiness: Array.from({ length: size }, (_, index) => blockedUnit(index)).reverse(),
    importJobs: { unitActivity: [], completeness: "complete" },
    pendingAliasCandidates: { total: 0, rows: [] },
    staleScopeRecords: { total: 0, rows: [] },
  };
  return {
    getCatalogAttentionQueueReadModel: async ({ window }) =>
      assembleCatalogAttentionQueue(sources, {
        generatedAt: COHORT_GENERATED_AT,
        parkedObservedItemKeys: new Set(),
        window: window ?? CATALOG_ATTENTION_SUMMARY_WINDOW,
      }),
    catalogAttentionDismissalCommandHandler: commandHandlerStub("active"),
  };
}

async function getQueue(services: CatalogAttentionQueueRouteServices, search = "") {
  const response = await buildApp(services).request(`/attention-queue${search ? `?${search}` : ""}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CatalogAttentionQueueReadModel;
}

// Follow `nextOffset` from offset 0 until the kind reports no more counted work.
async function walkProviderHealth(services: CatalogAttentionQueueRouteServices, limit: number) {
  const pages: CatalogAttentionQueueReadModel[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await getQueue(services, `kind=provider-health&limit=${limit}&offset=${offset}`);
    pages.push(page);
    offset = page.coverage["provider-health"].nextOffset;
    expect(pages.length).toBeLessThan(50);
  }
  return pages;
}

function commandHandlerStub(disposition: string) {
  return vi.fn().mockResolvedValue({ state: { disposition }, version: 2, newEvents: [], storedEvents: [] });
}

function buildApp(services: CatalogAttentionQueueRouteServices, actor = manageActor) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("/attention-queue/*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/attention-queue", catalogAttentionQueueRoutes(services));
  return app;
}

describe("attention-queue HTTP API", () => {
  it("returns the assembled read model on GET", async () => {
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: commandHandlerStub("active"),
    };
    const response = await buildApp(services).request("/attention-queue");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ empty: true, counts: { total: 0 } });
    expect(services.getCatalogAttentionQueueReadModel).toHaveBeenCalledWith(
      expect.objectContaining({ context, window: { kind: null, offset: 0, limit: 20 } }),
    );
  });

  it.each<[string, CatalogAttentionQueueWindow]>([
    ["limit=200&offset=400", { kind: null, offset: 400, limit: 200 }],
    ["limit=201", { kind: null, offset: 0, limit: 200 }],
    ["limit=100000&offset=-3", { kind: null, offset: 0, limit: 200 }],
    ["limit=0", { kind: null, offset: 0, limit: 1 }],
    ["limit=-5", { kind: null, offset: 0, limit: 1 }],
    ["limit=lots&offset=soon", { kind: null, offset: 0, limit: 20 }],
    ["kind=alias-candidate&offset=20", { kind: "alias-candidate", offset: 20, limit: 20 }],
  ])("clamps GET ?%s into a bounded window", async (search, window) => {
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: commandHandlerStub("active"),
    };
    const response = await buildApp(services).request(`/attention-queue?${search}`);
    expect(response.status).toBe(200);
    expect(services.getCatalogAttentionQueueReadModel).toHaveBeenCalledWith(expect.objectContaining({ window }));
  });

  it("rejects an unknown kind with 400 and never reads the queue", async () => {
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: commandHandlerStub("active"),
    };
    const response = await buildApp(services).request("/attention-queue?kind=everything&limit=20");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "attention_queue_unknown_kind" } });
    expect(services.getCatalogAttentionQueueReadModel).not.toHaveBeenCalled();
  });

  it("summarizes twenty per kind by default while counting the whole cohort", async () => {
    const queue = await getQueue(cohortServices(401));
    expect(queue.items).toHaveLength(20);
    expect(queue.counts.total).toBe(401);
    expect(queue.coverage["provider-health"]).toEqual({
      total: 401,
      totalKind: "exact",
      offset: 0,
      limit: 20,
      returned: 20,
      truncated: true,
      nextOffset: 20,
    });
  });

  it("returns a 200-item cohort in one maximal window and splits a 201-item cohort at position 201", async () => {
    const [exact] = await walkProviderHealth(cohortServices(200), 200);
    expect(exact!.items).toHaveLength(200);
    expect(exact!.coverage["provider-health"]).toMatchObject({ total: 200, truncated: false, nextOffset: null });

    const pages = await walkProviderHealth(cohortServices(201), 200);
    expect(pages.map((page) => page.items.length)).toEqual([200, 1]);
    expect(pages[0]!.coverage["provider-health"]).toMatchObject({ total: 201, truncated: true, nextOffset: 200 });
    expect(pages[1]!.coverage["provider-health"]).toMatchObject({ offset: 200, returned: 1, nextOffset: null });
    expect(pages[1]!.items[0]!.itemKey).toBe("provider-health:tcgdex:unit-0200");
  });

  it("follows every window of an unchanged 401-item cohort with tied timestamps and sees each key exactly once", async () => {
    const pages = await walkProviderHealth(cohortServices(401), 200);
    expect(pages.map((page) => page.items.length)).toEqual([200, 200, 1]);
    const keys = pages.flatMap((page) => page.items.map((item) => item.itemKey));
    expect(new Set(keys).size).toBe(401);
    expect(keys).toEqual(
      Array.from({ length: 401 }, (_, index) => `provider-health:tcgdex:unit-${String(index).padStart(4, "0")}`),
    );
    expect(pages.every((page) => page.counts.total === 401)).toBe(true);
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.observedAt)))).toEqual(
      new Set([COHORT_GENERATED_AT]),
    );

    // Smaller windows over the same cohort reconcile to the same keys.
    const small = await walkProviderHealth(cohortServices(401), 37);
    expect(small.flatMap((page) => page.items.map((item) => item.itemKey))).toEqual(keys);
  });

  it("returns an empty window, not an error, for an offset beyond the total", async () => {
    const queue = await getQueue(cohortServices(5), "kind=provider-health&offset=1000");
    expect(queue.items).toEqual([]);
    expect(queue.empty).toBe(false);
    expect(queue.coverage["provider-health"]).toEqual({
      total: 5,
      totalKind: "exact",
      offset: 1000,
      limit: 20,
      returned: 0,
      truncated: false,
      nextOffset: null,
    });
  });

  it("dispatches the dismissal aggregate keyed by item key and returns the committed snapshot", async () => {
    const handler = commandHandlerStub("dismissed");
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: handler,
    };
    const response = await buildApp(services).request("/attention-queue/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "dismiss",
        itemKey: "merge-conflict:c1",
        kind: "merge-conflict",
        reason: "waiting",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      intent: "dismiss",
      itemKey: "merge-conflict:c1",
      disposition: "dismissed",
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: catalogAttentionDismissalStreamId("merge-conflict:c1"),
        command: expect.objectContaining({ type: "DismissAttentionItem", itemKey: "merge-conflict:c1" }),
      }),
    );
  });

  it("defers with a computed re-surface time", async () => {
    const handler = commandHandlerStub("deferred");
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: handler,
    };
    const response = await buildApp(services).request("/attention-queue/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "defer",
        itemKey: "import-job:j1",
        kind: "import-job",
        reason: "later",
        deferHours: 12,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { disposition: string; deferredUntil: string };
    expect(body.disposition).toBe("deferred");
    expect(Number.isFinite(Date.parse(body.deferredUntil))).toBe(true);
  });

  it("rejects a park without a reason", async () => {
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: commandHandlerStub("dismissed"),
    };
    const response = await buildApp(services).request("/attention-queue/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "dismiss", itemKey: "merge-conflict:c1", kind: "merge-conflict" }),
    });
    expect(response.status).toBe(400);
  });

  it("requires catalog.manage to park an item", async () => {
    const services: CatalogAttentionQueueRouteServices = {
      getCatalogAttentionQueueReadModel: vi.fn().mockResolvedValue(emptyReadModel()),
      catalogAttentionDismissalCommandHandler: commandHandlerStub("dismissed"),
    };
    const response = await buildApp(services, viewOnlyActor).request("/attention-queue/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "dismiss", itemKey: "merge-conflict:c1", kind: "merge-conflict", reason: "x" }),
    });
    expect(response.status).toBe(403);
  });
});
