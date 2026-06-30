import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateIdentityRequestApiClient,
  mockCreateUserPreferencesColorModeCookieSeedHeaders,
  mockIdentityApi,
  mockRequestWithoutFreshWrite,
  mockRequireSignedInAdminActor,
  mockResolveIdentityShellViewer,
} = vi.hoisted(() => ({
  mockCreateIdentityRequestApiClient: vi.fn(),
  mockCreateUserPreferencesColorModeCookieSeedHeaders: vi.fn(),
  mockIdentityApi: { getUserPreferences: vi.fn() },
  mockRequestWithoutFreshWrite: vi.fn((request: Request) => request),
  mockRequireSignedInAdminActor: vi.fn(),
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
  });

  it("redirects one-section actors to their only visible section", async () => {
    mockRequireSignedInAdminActor.mockResolvedValue({ permissions: ["projection-operations.view"] });
    const request = new Request("https://admin.test/");

    try {
      await loader(createLoaderArgs(request));
      throw new Error("Expected admin root loader to redirect.");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(302);
      expect((error as Response).headers.get("Location")).toBe("/platform");
    }

    expect(mockResolveIdentityShellViewer).not.toHaveBeenCalled();
  });

  it("returns every actor-visible section for multi-section actors", async () => {
    const actor = { permissions: ["security.manage", "public-presence.view"] };
    const viewer = { actor, preferences: { colorMode: "dark" } };
    mockRequireSignedInAdminActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue(viewer);
    const request = new Request("https://admin.test/");

    const result = await loader(createLoaderArgs(request));

    expect(unwrapLoaderData(result)).toEqual({
      actor,
      sections: [
        expect.objectContaining({ key: "access", href: "/access" }),
        expect.objectContaining({ key: "growth", href: "/growth" }),
      ],
      viewer,
    });
  });

  it("keeps signed-in no-access actors on the explicit no-access hub", async () => {
    const actor = { permissions: [] };
    const viewer = { actor, preferences: null };
    mockRequireSignedInAdminActor.mockResolvedValue(actor);
    mockResolveIdentityShellViewer.mockResolvedValue(viewer);
    const request = new Request("https://admin.test/");

    const result = await loader(createLoaderArgs(request));

    expect(unwrapLoaderData(result)).toEqual({
      actor,
      sections: [],
      viewer,
    });
    expect(mockCreateIdentityRequestApiClient).toHaveBeenCalledWith(request);
    expect(mockResolveIdentityShellViewer).toHaveBeenCalledWith(mockIdentityApi, actor);
  });
});
