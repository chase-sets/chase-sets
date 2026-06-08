import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireAdminSectionActor } = vi.hoisted(() => ({
  mockRequireAdminSectionActor: vi.fn(),
}));

vi.mock("./auth.server", () => ({
  requireAdminSectionActor: mockRequireAdminSectionActor,
}));

import { createAdminSectionHomeLoader, createAdminSectionLoader } from "./admin-section-loader.server";

describe("admin section loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdminSectionActor.mockResolvedValue({ permissions: [] });
  });

  it.each([
    ["access", "/access/users", "accounts.view", "security.manage"],
    ["access", "/access/memberships/member_1", "accounts.view", "memberships.view"],
    ["growth", "/growth/waitlist", "google-shopping.view", "public-presence.view"],
    ["commerce", "/commerce/postage-policies", "commercial-terms.view", "postage-policies.view"],
    ["support", "/support/platform-feedback/pfb_1", "support.manage", "platform-feedback.view"],
  ] as const)(
    "challenges %s route %s with the route-specific permission",
    async (section, pathname, defaultPermission, expectedPermission) => {
      const loader = createAdminSectionLoader({ section, fallbackPermission: defaultPermission });
      const request = new Request(`https://admin.test${pathname}`);

      await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: pathname });

      expect(mockRequireAdminSectionActor).toHaveBeenCalledWith(request, section, expectedPermission);
    },
  );

  it("challenges section home routes for sign-in before resolving the actor-visible default", async () => {
    const loader = createAdminSectionHomeLoader({ section: "support", fallbackPermission: "support.manage" });
    const request = new Request("https://admin.test/support");

    await expect(loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/support" })).rejects
      .toMatchObject({ status: 403 });

    expect(mockRequireAdminSectionActor).toHaveBeenCalledWith(request, "support", "");
  });

  it("redirects partial-access section home actors to their first visible route", async () => {
    mockRequireAdminSectionActor.mockResolvedValue({ permissions: ["platform-feedback.view"] });
    const loader = createAdminSectionHomeLoader({ section: "support", fallbackPermission: "support.manage" });
    const request = new Request("https://admin.test/support");

    try {
      await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/support" });
      throw new Error("Expected section home loader to redirect.");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(302);
      expect((error as Response).headers.get("Location")).toBe("/support/platform-feedback");
    }
  });
});
