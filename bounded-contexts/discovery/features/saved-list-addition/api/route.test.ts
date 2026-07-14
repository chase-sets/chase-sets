import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryApiEnv } from "../../../api";
import { createSavedListPickerRoutes } from "./route";
import type { SavedListPickerServices } from "./runtime";

function buildApp(actor: DiscoveryApiEnv["Variables"]["actor"], services: SavedListPickerServices) {
  const app = new Hono<DiscoveryApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/account/saved-lists", createSavedListPickerRoutes(services));
  return app;
}

function actor(permissions: string[] = ["accounts.view"]): NonNullable<DiscoveryApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_1",
    accountId: "acc_1",
    membershipId: "mbr_1",
    roleKey: "owner",
    permissions,
  };
}

describe("Discovery Saved List Addition routes", () => {
  it("returns the signed-in account's local recent-list view", async () => {
    const services: SavedListPickerServices = {
      listRecent: vi.fn(async () => [
        {
          listId: "lst_1",
          title: "Trade targets",
          lineCount: 2,
          trackedUnitCount: 5,
          version: 4,
          changedAt: "2026-07-14T00:00:00.000Z",
        },
      ]),
    };
    const response = await buildApp(actor(), services).request("/account/saved-lists/recent");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ listId: "lst_1", title: "Trade targets" }],
      total: 1,
      count: 1,
    });
    expect(services.listRecent).toHaveBeenCalledWith({ ownerAccountId: "acc_1" });
  });

  it("requires authentication", async () => {
    const services: SavedListPickerServices = { listRecent: vi.fn(async () => []) };
    const response = await buildApp(null, services).request("/account/saved-lists/recent");

    expect(response.status).toBe(401);
    expect(services.listRecent).not.toHaveBeenCalled();
  });

  it("requires account read permission", async () => {
    const services: SavedListPickerServices = { listRecent: vi.fn(async () => []) };
    const response = await buildApp(actor([]), services).request("/account/saved-lists/recent");

    expect(response.status).toBe(403);
    expect(services.listRecent).not.toHaveBeenCalled();
  });
});
