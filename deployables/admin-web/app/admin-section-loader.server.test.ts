import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateIdentityRequestApiClient,
  mockIdentityApi,
  mockRequireAdminSectionActor,
  mockRequestWithoutFreshWrite,
  mockResolveIdentityShellViewer,
  mockCreateUserPreferencesColorModeCookieSeedHeaders,
} = vi.hoisted(() => ({
  mockCreateIdentityRequestApiClient: vi.fn(),
  mockIdentityApi: { getUserPreferences: vi.fn(), getCurrentActorDisplay: vi.fn() },
  mockRequireAdminSectionActor: vi.fn(),
  mockRequestWithoutFreshWrite: vi.fn((request: Request) => {
    const url = new URL(request.url);
    url.searchParams.delete("afterWrite");
    return new Request(url, request);
  }),
  mockResolveIdentityShellViewer: vi.fn(),
  mockCreateUserPreferencesColorModeCookieSeedHeaders: vi.fn(),
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
  createUserPreferencesColorModeCookieSeedHeaders: mockCreateUserPreferencesColorModeCookieSeedHeaders,
  requestWithoutFreshWrite: mockRequestWithoutFreshWrite,
  resolveIdentityShellViewer: mockResolveIdentityShellViewer,
}));

vi.mock("./auth.server", () => ({
  requireAdminSectionActor: mockRequireAdminSectionActor,
}));

import { createAdminSectionHomeLoader, createAdminSectionLoader } from "./admin-section-loader.server";

type LoaderDataResult<T> = Readonly<{
  type: string;
  data: T;
  init?: ResponseInit | null;
}>;

function isLoaderDataResult<T>(value: unknown): value is LoaderDataResult<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "DataWithResponseInit" &&
    "data" in value
  );
}

function unwrapLoaderData<T>(value: T | LoaderDataResult<T>): T {
  return isLoaderDataResult<T>(value) ? value.data : value;
}

function loaderHeaders(value: unknown) {
  return isLoaderDataResult<unknown>(value) ? new Headers(value.init?.headers) : new Headers();
}

describe("admin section loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdminSectionActor.mockResolvedValue({ permissions: [] });
    mockCreateIdentityRequestApiClient.mockReturnValue(mockIdentityApi);
    mockResolveIdentityShellViewer.mockResolvedValue({ actor: null, preferences: null });
    mockIdentityApi.getCurrentActorDisplay.mockResolvedValue(null);
    mockCreateUserPreferencesColorModeCookieSeedHeaders.mockReturnValue(null);
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

  it("folds the resolved actor and Identity preferences into the shell viewer read model", async () => {
    const actor = { permissions: ["catalog.view"], userId: "usr_admin" };
    const viewer = { actor, preferences: { colorMode: "dark", reducedMotion: "user" } };
    const actorDisplay = {
      account: { account_id: "acc_admin", display_name: "Card Vault", name: "Card Vault LLC", badges: [] },
      membership: { membership_id: "mbr_admin", role_key: "owner" },
      user: { user_id: "usr_admin", display_name: "Alex Clerk", primary_email: "alex@example.com" },
    };
    const cookieHeaders = new Headers({ "Set-Cookie": "chase_sets_color_mode=dark" });
    mockRequireAdminSectionActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue(viewer);
    mockIdentityApi.getCurrentActorDisplay.mockResolvedValue(actorDisplay);
    mockCreateUserPreferencesColorModeCookieSeedHeaders.mockReturnValue(cookieHeaders);
    const loader = createAdminSectionLoader({ section: "catalog", fallbackPermission: "catalog.view" });
    const request = new Request("https://admin.test/catalog?afterWrite=fresh-route-receipt");

    const result = await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/catalog" });

    expect(unwrapLoaderData(result)).toEqual({
      actor,
      actorDisplay,
      viewer,
    });
    expect(loaderHeaders(result).get("Set-Cookie")).toBe("chase_sets_color_mode=dark");

    expect(mockRequestWithoutFreshWrite).toHaveBeenCalledWith(request);
    expect(mockCreateIdentityRequestApiClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://admin.test/catalog" }),
    );
    expect(mockResolveIdentityShellViewer).toHaveBeenCalledWith(mockIdentityApi, actor);
    expect(mockIdentityApi.getCurrentActorDisplay).toHaveBeenCalled();
    expect(mockCreateUserPreferencesColorModeCookieSeedHeaders).toHaveBeenCalledWith(request, "dark");
  });

  it("falls back to a null actor display when Identity's current-actor-display read fails", async () => {
    const actor = { permissions: ["catalog.view"], userId: "usr_admin" };
    mockRequireAdminSectionActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue({ actor, preferences: null });
    mockIdentityApi.getCurrentActorDisplay.mockRejectedValue(new Error("boom"));
    const loader = createAdminSectionLoader({ section: "catalog", fallbackPermission: "catalog.view" });
    const request = new Request("https://admin.test/catalog");

    const result = await loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/catalog" });

    expect(unwrapLoaderData(result)).toMatchObject({ actorDisplay: null });
  });

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
      expect((error as Response).headers.get("Location")).toBe("/support/csat");
    }
  });

  it.each([
    ["access", "accounts.view", "security.manage", "/access/users"],
    ["access", "accounts.view", "memberships.view", "/access/memberships"],
    ["growth", "google-shopping.view", "public-presence.view", "/growth/waitlist"],
    ["commerce", "commercial-terms.view", "postage-policies.view", "/commerce/postage-policies"],
    ["support", "support.manage", "platform-feedback.view", "/support/csat"],
    ["platform", "projection-operations.view", "projection-operations.view", "/platform/projections"],
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
