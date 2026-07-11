import { describe, expect, it, vi } from "vitest";
import { loader as sessionsLoader } from "./sessions";

const { mockCreateAuthRequestApiClient, listSessions } = vi.hoisted(() => ({
  mockCreateAuthRequestApiClient: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../support/request-support/api-client", () => ({
  createAuthRequestApiClient: mockCreateAuthRequestApiClient,
}));

mockCreateAuthRequestApiClient.mockReturnValue({ listSessions });

function loaderRequest(path: string) {
  return new Request(`https://access-admin.chasesets.test${path}`);
}

describe("Access-admin sessions list route", () => {
  it("forwards URL pagination to the sessions API list", async () => {
    listSessions.mockResolvedValue({ items: [], total: 0, count: 0 });

    await sessionsLoader({
      request: loaderRequest("/access/sessions?limit=25&offset=50"),
      params: {},
      context: undefined,
    } as never);

    expect(listSessions).toHaveBeenCalledWith("limit=25&offset=50");
  });

  it("forwards status and search filters onto the sessions API list query", async () => {
    listSessions.mockResolvedValue({ items: [], total: 0, count: 0 });

    await sessionsLoader({
      request: loaderRequest("/access/sessions?status=revoked&search=alex"),
      params: {},
      context: undefined,
    } as never);

    expect(listSessions).toHaveBeenCalledWith("limit=50&offset=0&status=revoked&search=alex");
  });

  it("drops an unrecognized status filter before forwarding the query", async () => {
    listSessions.mockResolvedValue({ items: [], total: 0, count: 0 });

    await sessionsLoader({
      request: loaderRequest("/access/sessions?status=not-a-real-status"),
      params: {},
      context: undefined,
    } as never);

    expect(listSessions).toHaveBeenCalledWith("limit=50&offset=0");
  });

  it("returns the normalized filters alongside pagination for the UI", async () => {
    listSessions.mockResolvedValue({ items: [], total: 0, count: 0 });

    const data = await sessionsLoader({
      request: loaderRequest("/access/sessions?status=active&search=alex&limit=10&offset=20"),
      params: {},
      context: undefined,
    } as never);

    expect(data).toMatchObject({
      limit: 10,
      offset: 20,
      filters: { status: "active", search: "alex" },
    });
  });
});
