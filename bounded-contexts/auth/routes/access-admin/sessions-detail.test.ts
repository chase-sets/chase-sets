import type { ActionFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { decodeFreshWriteReceipt } from "@chase-sets/http/responses";
import { action as accessAction } from "./sessions-detail";
import { action as marketplaceAction } from "../marketplace/account-sessions-detail";

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
