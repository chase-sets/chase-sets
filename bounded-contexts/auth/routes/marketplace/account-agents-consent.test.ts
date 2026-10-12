import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "../../client";
import { action, headers, loader } from "./account-agents-consent";

const mocks = vi.hoisted(() => ({ getAgentConsent: vi.fn(), switchSessionAccount: vi.fn() }));
vi.mock("../../support/request-support/api-client", () => ({
  createUcpOAuthRequestApiClient: () => ({ getAgentConsent: mocks.getAgentConsent }),
  createAuthRequestApiClient: () => ({ switchSessionAccount: mocks.switchSessionAccount }),
}));

const consent = {
  clientName: "Synthetic Agent",
  redirectOrigin: "https://agent.example",
  sessionId: "synthetic-session",
  accountId: "account-one",
  accountName: "Account One",
  scopes: ["order:read"],
  memberships: [
    { accountId: "account-one", accountName: "Account One" },
    { accountId: "account-two", accountName: "Account Two" },
  ],
  authorizePath: "/ucp/oauth/authorize?client_id=synthetic-client&response_type=code",
};

function args(request: Request): LoaderFunctionArgs & ActionFunctionArgs {
  return { request, params: {}, context: {}, url: new URL(request.url), pattern: "/account/agents/consent" };
}
function request() {
  return new Request("https://marketplace.example/account/agents/consent?consent_token=synthetic-token");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAgentConsent.mockResolvedValue({ consent });
});

describe("OAuth consent marketplace route", () => {
  it("loads the session-bound request and protects all document states", async () => {
    const result = await loader(args(request()));
    expect(result.data).toEqual({ consent, consentToken: "synthetic-token" });
    expect(mocks.getAgentConsent).toHaveBeenCalledWith("synthetic-token");
    const resultHeaders = headers();
    expect(resultHeaders.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(resultHeaders.get("Content-Security-Policy")).not.toContain("form-action");
    expect(resultHeaders.get("Referrer-Policy")).toBe("no-referrer");
    expect(resultHeaders.get("Cache-Control")).toBe("no-store");
  });
  it.each([400, 404])("renders an invalid request for API status %s without leaking the token", async (status) => {
    mocks.getAgentConsent.mockRejectedValue(new AuthApiError(status, { error: "invalid_request" }));
    const result = await loader(args(request()));
    expect(result.data).toEqual({ consent: null, consentToken: "" });
  });
  it("redirects a signed-out loader through sign-in with its full return path", async () => {
    mocks.getAgentConsent.mockRejectedValue(new AuthApiError(401, {}));
    await expect(loader(args(request()))).rejects.toMatchObject({ status: 302 });
    try {
      await loader(args(request()));
    } catch (error) {
      const response = error as Response;
      const location = new URL(response.headers.get("location")!, "https://marketplace.example");
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("returnTo")).toBe("/account/agents/consent?consent_token=synthetic-token");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });
  it("switches only an offered membership on the bound session then restarts authorize", async () => {
    const response = await action(
      args(
        new Request(request(), {
          method: "POST",
          headers: { Origin: "https://marketplace.example" },
          body: new URLSearchParams({ accountId: "account-two", consent_token: "synthetic-token" }),
        }),
      ),
    );
    expect(mocks.switchSessionAccount).toHaveBeenCalledWith("synthetic-session", "account-two");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(consent.authorizePath);
  });
  it.each(["foreign-origin", "cross-site", "missing-origin", "foreign-account"])(
    "refuses %s account switching",
    async (governing) => {
      const fields = new URLSearchParams({
        accountId: governing === "foreign-account" ? "foreign-account" : "account-two",
        consent_token: "synthetic-token",
      });
      const origin =
        governing === "foreign-origin"
          ? "https://attacker.example"
          : governing === "missing-origin"
            ? ""
            : "https://marketplace.example";
      const response = await action(
        args(
          new Request(request(), {
            method: "POST",
            body: fields,
            headers: {
              ...(governing === "missing-origin" ? {} : { Origin: origin }),
              "Sec-Fetch-Site": governing === "cross-site" ? "cross-site" : "same-origin",
            },
          }),
        ),
      );
      expect(response.status).toBe(403);
      expect(mocks.switchSessionAccount).not.toHaveBeenCalled();
    },
  );
});
