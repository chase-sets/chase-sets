import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { catalogAttentionDismissalStreamId } from "../domain/dismissal";
import { catalogAttentionQueueRoutes, type CatalogAttentionQueueRouteServices } from "./route";
import type { CatalogAttentionQueueReadModel } from "./contracts";

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
  return {
    generatedAt: "2026-07-09T00:00:00.000Z",
    empty: true,
    items: [],
    counts: {
      total: 0,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      byKind: {
        "unmapped-scope": 0,
        "merge-conflict": 0,
        "provider-health": 0,
        "import-job": 0,
        "alias-candidate": 0,
        "stale-scope-sync": 0,
      },
    },
    freshness: { generatedAt: "2026-07-09T00:00:00.000Z", oldestObservedAt: null, newestObservedAt: null },
  };
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
