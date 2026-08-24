import { describe, expect, it, vi } from "vitest";
import { createGuestSavedListRoutes, createSavedListRoutes } from "./route";

describe("Saved List discovery routes", () => {
  it("localizes signed-out access failures without revealing account or List data", async () => {
    const app = createSavedListRoutes({ listRecent: vi.fn() } as never);
    const response = await app.request("http://collections.test/account/lists/recent");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "authentication_required", message: "Sign in to manage Saved Lists." },
    });
  });

  it("requires the opaque anonymous owner for guest capture", async () => {
    const app = createGuestSavedListRoutes({ createAnonymousIntent: vi.fn() } as never);
    const response = await app.request("http://collections.test/saved-list-intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "anonymous_saved_list_required",
        message: "This Saved List addition is no longer available. Save the Product again.",
      },
    });
  });
});
