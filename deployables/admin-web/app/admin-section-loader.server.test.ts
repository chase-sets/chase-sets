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
    ["access", "/access/api-keys/key_1", "accounts.view", "security.manage"],
    ["access", "/access/sessions/session_1", "accounts.view", "security.manage"],
    ["access", "/access/memberships/member_1", "accounts.view", "memberships.view"],
    ["access", "/access/invitations/inv_1", "accounts.view", "memberships.view"],
    ["growth", "/growth/waitlist", "google-shopping.view", "public-presence.view"],
    ["growth", "/growth/promo-bar", "google-shopping.view", "public-presence.view"],
    ["commerce", "/commerce/terms/schedules/schedule_1", "commercial-terms.view", "commercial-terms.view"],
    ["commerce", "/commerce/postage-policies", "commercial-terms.view", "postage-policies.view"],
    ["support", "/support/requests/request_1", "support.manage", "support.manage"],
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

    await expect(
      loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/support" }),
    ).rejects.toMatchObject({ status: 403 });

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

  it.each([
    ["access", "accounts.view", "security.manage", "/access/users"],
    ["access", "accounts.view", "memberships.view", "/access/memberships"],
    ["growth", "google-shopping.view", "public-presence.view", "/growth/waitlist"],
    ["commerce", "commercial-terms.view", "postage-policies.view", "/commerce/postage-policies"],
    ["support", "support.manage", "platform-feedback.view", "/support/platform-feedback"],
    ["platform", "security.manage", "security.manage", "/platform/projections"],
  ] as const)(
    "redirects %s section home actors with %s to their first visible route",
    async (section, fallbackPermission, actorPermission, expectedLocation) => {
      mockRequireAdminSectionActor.mockResolvedValue({ permissions: [actorPermission] });
      const loader = createAdminSectionHomeLoader({ section, fallbackPermission });
      const request = new Request(`https://admin.test/${section}`);

      try {
        await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: `/${section}` });
        throw new Error("Expected section home loader to redirect.");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(302);
        expect((error as Response).headers.get("Location")).toBe(expectedLocation);
      }

      expect(mockRequireAdminSectionActor).toHaveBeenCalledWith(request, section, "");
    },
  );
});
