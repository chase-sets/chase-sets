import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CollectionsApiEnv } from "../../../api";
import { buildCollectionsApi } from "../../../api";
import { SavedListQueryError } from "../read-model/queries";

function appWithActor(readModels: Record<string, unknown>, accountId = "acc_owner") {
  const root = new Hono<CollectionsApiEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", { accountId, permissions: [] });
    await next();
  });
  root.route(
    "/",
    buildCollectionsApi({
      savedListReadModels: readModels,
    } as never),
  );
  return root;
}

describe("Saved List query API", () => {
  it("returns a separate My Collection Saved Lists module with account-scoped filters", async () => {
    const loadMyCollectionModule = vi.fn(async () => ({
      contractVersion: 1,
      kind: "saved-lists",
      savedLists: { items: [], total: 0, nextCursor: null },
    }));
    const app = appWithActor({ loadMyCollectionModule, loadDetail: vi.fn() });

    const response = await app.request("/saved-lists?search=dragon&visibility=private,unlisted&lifecycle=all&limit=50");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: 1,
      kind: "saved-lists",
      savedLists: { items: [], total: 0, nextCursor: null },
    });
    expect(loadMyCollectionModule).toHaveBeenCalledWith({
      ownerAccountId: "acc_owner",
      search: "dragon",
      visibilities: ["private", "unlisted"],
      lifecycle: "all",
      cursor: undefined,
      limit: 50,
    });
  });

  it("does not disclose another account's detail existence", async () => {
    const loadDetail = vi.fn(async () => null);
    const app = appWithActor({ loadMyCollectionModule: vi.fn(), loadDetail });

    const response = await app.request("/saved-lists/svl_private");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found" } });
    expect(loadDetail).toHaveBeenCalledWith({ ownerAccountId: "acc_owner", listId: "svl_private" });
  });

  it("rejects invalid filters and cursors with localized-client error codes", async () => {
    const loadMyCollectionModule = vi.fn(async () => {
      throw new SavedListQueryError();
    });
    const app = appWithActor({ loadMyCollectionModule, loadDetail: vi.fn() });

    expect((await app.request("/saved-lists?visibility=shared")).status).toBe(400);
    const cursorResponse = await app.request("/saved-lists?cursor=broken");
    expect(cursorResponse.status).toBe(400);
    expect(await cursorResponse.json()).toEqual({ error: { code: "invalid_cursor" } });
  });

  it("requires the host to provide an authenticated actor", async () => {
    const app = buildCollectionsApi({
      savedListReadModels: { loadMyCollectionModule: vi.fn(), loadDetail: vi.fn() },
    } as never);

    const response = await app.request("/saved-lists");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "authentication_required" } });
  });
});
