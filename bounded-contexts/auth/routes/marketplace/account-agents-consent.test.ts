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
  scopes: ["dev.ucp.shopping.order:read"],
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
function switchRequest() {
  return new Request(request(), {
    method: "POST",
    headers: { Origin: "https://marketplace.example", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ accountId: "account-two", consent_token: "synthetic-token" }),
  });
}
function expectProtectedHeaders(resultHeaders: Headers) {
  expect(resultHeaders.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  expect(resultHeaders.get("Content-Security-Policy")).not.toContain("form-action");
  expect(resultHeaders.get("Referrer-Policy")).toBe("strict-origin");
  expect(resultHeaders.get("Cache-Control")).toBe("no-store");
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
    expect(resultHeaders.get("Referrer-Policy")).toBe("strict-origin");
    expect(resultHeaders.get("Cache-Control")).toBe("no-store");
  });
  it("pins strict-origin for native consent POST Origin", () => {
    // https://fetch.spec.whatwg.org/#append-a-request-origin-header: no-referrer nulls native POST Origin.
    expect(headers().get("Referrer-Policy")).toBe("strict-origin");
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
      expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
    }
  });
  it.each([400, 404])(
    "redirects an invalid account-switch consent request back to its invalid state (%s)",
    async (status) => {
      mocks.getAgentConsent.mockRejectedValue(new AuthApiError(status, { error: "invalid_request" }));
      const response = await action(args(switchRequest()));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/account/agents/consent?consent_token=synthetic-token");
      expectProtectedHeaders(response.headers);
      expect(mocks.switchSessionAccount).not.toHaveBeenCalled();
      const result = await loader(args(request()));
      expect(result.data).toEqual({ consent: null, consentToken: "" });
      expectProtectedHeaders(new Headers(result.init?.headers));
    },
  );
  it("redirects a signed-out account-switch consent request through sign-in", async () => {
    mocks.getAgentConsent.mockRejectedValue(new AuthApiError(401, {}));
    const response = await action(args(switchRequest())).then(
      () => {
        throw new Error("Expected the sign-in redirect to be thrown");
      },
      (error: unknown) => error,
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw response;
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, "https://marketplace.example");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("returnTo")).toBe("/account/agents/consent?consent_token=synthetic-token");
    expectProtectedHeaders(response.headers);
    expect(mocks.switchSessionAccount).not.toHaveBeenCalled();
  });
  it.each([new AuthApiError(500, {}), new Error("synthetic upstream failure")])(
    "rethrows unexpected account-switch consent errors without switching (%s)",
    async (error) => {
      mocks.getAgentConsent.mockRejectedValue(error);
      await expect(action(args(switchRequest()))).rejects.toBe(error);
      expect(mocks.switchSessionAccount).not.toHaveBeenCalled();
    },
  );
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
  it.each(["foreign-origin", "cross-site", "missing-origin", "null-origin", "foreign-account"])(
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
            : governing === "null-origin"
              ? "null"
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
      expect(response.headers.has("location")).toBe(false);
      expect(mocks.switchSessionAccount).not.toHaveBeenCalled();
      if (governing !== "foreign-account") expect(mocks.getAgentConsent).not.toHaveBeenCalled();
    },
  );
});
