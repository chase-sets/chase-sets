import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { decodeCommitReceipt } from "@chase-sets/http/responses";
import { attachWriteConsistencyMiddleware } from "./index";

vi.mock("@chase-sets/event-core", () => ({
  runWithEventCommitMetadata: async (action: () => Promise<void>) => action(),
  getEventCommitMetadata: () => ({
    eventIds: ["evt_listing_published"],
    maxGlobalPosition: "42",
    sources: [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_listing_published"],
      },
    ],
  }),
}));

describe("bounded context write consistency middleware", () => {
  it("attaches commit metadata headers to mutation responses", async () => {
    const app = new Hono();

    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/marketplace" }]);
    app.post("/api/marketplace/account/listings", (context) => context.json({ id: "lst_1", status: "published" }, 201));

    const response = await app.request("/api/marketplace/account/listings", { method: "POST" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Chase-Sets-Consistency")).toBe("eventual");
    expect(response.headers.get("Chase-Sets-Commit-Position")).toBe("42");
    expect(response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe("evt_listing_published");
    expect(decodeCommitReceipt(response.headers.get("Chase-Sets-Commit-Receipt"))).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_listing_published"],
      },
    ]);
  });

  it("does not attach commit metadata headers to reads", async () => {
    const app = new Hono();

    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/marketplace" }]);
    app.get("/api/marketplace/items/charizard", (context) => context.json({ id: "charizard" }));

    const response = await app.request("/api/marketplace/items/charizard");

    expect(response.status).toBe(200);
    expect(response.headers.get("Chase-Sets-Consistency")).toBeNull();
    expect(response.headers.get("Chase-Sets-Commit-Receipt")).toBeNull();
  });
});
