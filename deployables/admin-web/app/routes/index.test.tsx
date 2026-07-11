import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateIdentityRequestApiClient,
  mockCreateUserPreferencesColorModeCookieSeedHeaders,
  mockIdentityApi,
  mockRequestWithoutFreshWrite,
  mockRequireSignedInAdminActor,
  mockResolveAdminWebSectionNavItems,
  mockResolveIdentityShellViewer,
} = vi.hoisted(() => ({
  mockCreateIdentityRequestApiClient: vi.fn(),
  mockCreateUserPreferencesColorModeCookieSeedHeaders: vi.fn(),
  mockIdentityApi: { getUserPreferences: vi.fn(), getCurrentActorDisplay: vi.fn() },
  mockRequestWithoutFreshWrite: vi.fn((request: Request) => request),
  mockRequireSignedInAdminActor: vi.fn(),
  mockResolveAdminWebSectionNavItems: vi.fn(),
  mockResolveIdentityShellViewer: vi.fn(),
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
  createUserPreferencesColorModeCookieSeedHeaders: mockCreateUserPreferencesColorModeCookieSeedHeaders,
  requestWithoutFreshWrite: mockRequestWithoutFreshWrite,
  resolveIdentityShellViewer: mockResolveIdentityShellViewer,
}));

vi.mock("../auth.server", () => ({
  requireSignedInAdminActor: mockRequireSignedInAdminActor,
}));

vi.mock("../host", () => ({
  resolveAdminWebSectionNavItems: mockResolveAdminWebSectionNavItems,
}));

import { loader } from "./index";

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

function createLoaderArgs(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: "/",
  };
}

describe("admin root loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateIdentityRequestApiClient.mockReturnValue(mockIdentityApi);
    mockCreateUserPreferencesColorModeCookieSeedHeaders.mockReturnValue(null);
    mockResolveIdentityShellViewer.mockResolvedValue({ actor: null, preferences: null });
    mockIdentityApi.getCurrentActorDisplay.mockResolvedValue(null);
    mockResolveAdminWebSectionNavItems.mockReturnValue([]);
  });

  it("redirects one-section actors to their only visible section", async () => {
    mockRequireSignedInAdminActor.mockResolvedValue({ permissions: ["support.manage"] });
    mockResolveAdminWebSectionNavItems.mockReturnValue([{ key: "support", label: "Support", href: "/support" }]);
    const request = new Request("https://admin.test/");

    try {
      await loader(createLoaderArgs(request));
      throw new Error("Expected admin root loader to redirect.");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(302);
      expect((error as Response).headers.get("Location")).toBe("/support");
    }

    expect(mockResolveIdentityShellViewer).not.toHaveBeenCalled();
  });

  it("returns every actor-visible section for multi-section actors", async () => {
    const actor = { permissions: ["security.manage", "public-presence.view"] };
    const viewer = { actor, preferences: { colorMode: "dark" } };
    const sections = [
      { key: "access", label: "Access", href: "/access" },
      { key: "growth", label: "Growth", href: "/growth" },
    ];
    mockRequireSignedInAdminActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue(viewer);
    mockResolveAdminWebSectionNavItems.mockReturnValue(sections);
    const request = new Request("https://admin.test/");

    const result = await loader(createLoaderArgs(request));

    expect(unwrapLoaderData(result)).toEqual({
      actor,
      actorDisplay: null,
      sections,
      viewer,
    });
  });

  it("keeps signed-in no-access actors on the explicit no-access hub", async () => {
    const actor = { permissions: ["unknown.permission"] };
    const viewer = { actor, preferences: null };
    mockRequireSignedInAdminActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue(viewer);
    const request = new Request("https://admin.test/");

    const result = await loader(createLoaderArgs(request));

    expect(unwrapLoaderData(result)).toEqual({
      actor,
      actorDisplay: null,
      sections: [],
      viewer,
    });
    expect(mockCreateIdentityRequestApiClient).toHaveBeenCalledWith(request);
    expect(mockResolveIdentityShellViewer).toHaveBeenCalledWith(mockIdentityApi, actor);
  });
});
