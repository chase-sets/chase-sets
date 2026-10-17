import type { ActionFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { decodeFreshWriteReceipt } from "@chase-sets/http/responses";
import { action as accessAction, loader as accessLoader } from "./sessions-detail";
import { action as marketplaceAction, loader as marketplaceLoader } from "../marketplace/account-sessions-detail";
import { identitySeedIds } from "@chase-sets/identity-seed";
import type { Session } from "../../features/sessions/ui/contracts";

const { mockCreateAuthRequestApiClient } = vi.hoisted(() => ({
  mockCreateAuthRequestApiClient: vi.fn(),
}));

vi.mock("../../support/request-support/api-client", () => ({
  createAuthRequestApiClient: mockCreateAuthRequestApiClient,
}));

const authSource = {
  sourceContextName: "auth",
  maxGlobalPosition: "42",
  eventIds: ["evt_auth"],
};

function withCommandReceipt<T extends object>(result: T): T {
  Object.defineProperty(result, "commandReceipt", {
    value: {
      mode: "eventual",
      commitEventIds: ["evt_auth"],
      commitPositions: [authSource],
    },
    enumerable: false,
  });
  return result;
}

function readReceipt(location: string) {
  const token = new URL(location, "http://localhost").searchParams.get("afterWrite");
  return decodeFreshWriteReceipt(token);
}

function createActionArgs(request: Request, params: ActionFunctionArgs["params"], pattern: string): ActionFunctionArgs {
  return {
    request,
    params,
    context: {},
    url: new URL(request.url),
    pattern,
  };
}

describe("session detail actions", () => {
  it("redirects access session revokes with the Auth command receipt", async () => {
    const revokeSession = vi.fn(async () => withCommandReceipt({ id: "ses_1", version: 3, status: "revoked" }));
    mockCreateAuthRequestApiClient.mockReturnValue({
      revokeSession,
      switchSessionAccount: vi.fn(),
    });

    const request = new Request("http://localhost/access/sessions/ses_1", {
      method: "POST",
      body: new URLSearchParams({ intent: "revoke" }),
    });
    const response = (await accessAction(
      createActionArgs(request, { id: "ses_1" }, "/access/sessions/:id"),
    )) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/access/sessions/ses_1?afterWrite=");
    expect(readReceipt(location)).toMatchObject({ sources: [authSource] });
    expect(revokeSession).toHaveBeenCalledWith("ses_1");
  });

  it("redirects access session account switches with the Auth command receipt", async () => {
    const switchSessionAccount = vi.fn(async () => withCommandReceipt({ id: "ses_1", version: 4, status: "active" }));
    mockCreateAuthRequestApiClient.mockReturnValue({
      revokeSession: vi.fn(),
      switchSessionAccount,
    });

    const request = new Request("http://localhost/access/sessions/ses_1", {
      method: "POST",
      body: new URLSearchParams({
        intent: "switch-account",
        accountId: "acct_2",
      }),
    });
    const response = (await accessAction(
      createActionArgs(request, { id: "ses_1" }, "/access/sessions/:id"),
    )) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/access/sessions/ses_1?afterWrite=");
    expect(readReceipt(location)).toMatchObject({ sources: [authSource] });
    expect(switchSessionAccount).toHaveBeenCalledWith("ses_1", "acct_2");
  });

  it("redirects marketplace session account switches with the Auth command receipt", async () => {
    const switchSessionAccount = vi.fn(async () => withCommandReceipt({ id: "ses_2", version: 4, status: "active" }));
    mockCreateAuthRequestApiClient.mockReturnValue({
      revokeSession: vi.fn(),
      switchSessionAccount,
    });

    const request = new Request("http://localhost/account/sessions/ses_2", {
      method: "POST",
      body: new URLSearchParams({
        intent: "switch-account",
        accountId: "acct_2",
      }),
    });
    const response = (await marketplaceAction(
      createActionArgs(request, { id: "ses_2" }, "/account/sessions/:id"),
    )) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/account/sessions/ses_2?afterWrite=");
    expect(readReceipt(location)).toMatchObject({ sources: [authSource] });
    expect(switchSessionAccount).toHaveBeenCalledWith("ses_2", "acct_2");
  });
});

describe("seeded session detail loaders", () => {
  const cases = [
    { loader: accessLoader, destination: "/access/sessions", fixture: identitySeedIds.demo, status: "active" },
    { loader: accessLoader, destination: "/access/sessions", fixture: identitySeedIds.support, status: "active" },
    { loader: accessLoader, destination: "/access/sessions", fixture: identitySeedIds.collector, status: "expired" },
    {
      loader: marketplaceLoader,
      destination: "/account/sessions",
      fixture: identitySeedIds.collector,
      status: "expired",
    },
  ];

  it.each(cases)("forwards $fixture.sessionId at $destination", async ({ loader, destination, fixture, status }) => {
    const data: Session = {
      session_id: fixture.sessionId,
      user_id: fixture.userId,
      account_id:
        fixture.sessionId === identitySeedIds.support.sessionId ? identitySeedIds.demo.accountId : fixture.accountId,
      available_account_ids:
        fixture.sessionId === identitySeedIds.support.sessionId
          ? [fixture.accountId, identitySeedIds.demo.accountId]
          : [fixture.accountId],
      authentication_method: fixture.sessionId === identitySeedIds.support.sessionId ? "magic-link" : "password",
      status,
      expires_at: status === "expired" ? "2026-10-04T12:00:00.000Z" : "2026-11-04T12:00:00.000Z",
      updated_at: "2026-10-05T12:00:00.000Z",
    };
    const getSession = vi.fn().mockResolvedValue(data);
    mockCreateAuthRequestApiClient.mockReturnValue({ getSession });
    const request = new Request(`https://chasesets.test${destination}/${fixture.sessionId}`);

    expect(await loader({ request, params: { id: fixture.sessionId }, context: undefined } as never)).toEqual({
      id: fixture.sessionId,
      data,
    });
    expect(mockCreateAuthRequestApiClient).toHaveBeenCalledWith(request);
    expect(getSession).toHaveBeenCalledWith(fixture.sessionId);
  });

  it.each([accessLoader, marketplaceLoader])(
    "does not replace a rejected API detail read with a successful fixture",
    async (loader) => {
      const error = new Response("Not found", { status: 404 });
      mockCreateAuthRequestApiClient.mockReturnValue({ getSession: vi.fn().mockRejectedValue(error) });
      await expect(
        loader({
          request: new Request("https://chasesets.test/sessions/ses_synthetic_nonexistent"),
          params: { id: "ses_synthetic_nonexistent" },
          context: undefined,
        } as never),
      ).rejects.toBe(error);
    },
  );
});
