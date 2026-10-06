import { describe, expect, it, vi } from "vitest";
import { loader as sessionsLoader } from "./sessions";
import { loader as marketplaceSessionsLoader } from "../marketplace/account-sessions";
import { identitySeedIds } from "@chase-sets/identity-seed";
import type { Session } from "../../features/sessions/ui/contracts";

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
  const bootstrapTime = Date.parse("2026-10-05T12:00:00.000Z");
  const dayMs = 24 * 60 * 60 * 1_000;
  const seededSessions: Session[] = [identitySeedIds.demo, identitySeedIds.support, identitySeedIds.collector].map(
    (fixture) => ({
      session_id: fixture.sessionId,
      user_id: fixture.userId,
      account_id:
        fixture.sessionId === identitySeedIds.support.sessionId ? identitySeedIds.demo.accountId : fixture.accountId,
      available_account_ids:
        fixture.sessionId === identitySeedIds.support.sessionId
          ? [fixture.accountId, identitySeedIds.demo.accountId]
          : [fixture.accountId],
      authentication_method: fixture.sessionId === identitySeedIds.support.sessionId ? "magic-link" : "password",
      status: fixture.sessionId === identitySeedIds.collector.sessionId ? "expired" : "active",
      expires_at: new Date(
        bootstrapTime + (fixture.sessionId === identitySeedIds.collector.sessionId ? -1 : 30) * dayMs,
      ).toISOString(),
      updated_at: new Date(bootstrapTime).toISOString(),
    }),
  );

  it("forwards the authorized three-session response at the Access admin destination with all statuses", async () => {
    const response = { items: seededSessions, total: 3, count: 3 };
    listSessions.mockResolvedValue(response);
    const request = loaderRequest("/access/sessions?status=all");
    const data = await sessionsLoader({ request, params: {}, context: undefined } as never);

    expect(mockCreateAuthRequestApiClient).toHaveBeenCalledWith(request);
    expect(listSessions).toHaveBeenCalledWith("limit=50&offset=0");
    expect(data).toEqual({ ...response, limit: 50, offset: 0, filters: { status: "all", search: "" } });
  });

  it("forwards the authorized expired collector response at the marketplace destination without adding a status filter", async () => {
    const response = { items: [seededSessions[2]], total: 1, count: 1 };
    listSessions.mockResolvedValue(response);
    const request = loaderRequest("/account/sessions");
    const data = await marketplaceSessionsLoader({ request, params: {}, context: undefined } as never);

    expect(mockCreateAuthRequestApiClient).toHaveBeenCalledWith(request);
    expect(listSessions).toHaveBeenCalledWith("limit=50&offset=0");
    expect(data).toEqual(response);
  });

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
