import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { action as accountDetailAction, loader as accountDetailLoader } from "../routes/admin/accounts-detail";
import { action as apiKeyDetailAction } from "../routes/admin/api-keys-detail";
import { action as apiKeysAction } from "../routes/admin/api-keys";
import { action as invitationDetailAction, loader as invitationDetailLoader } from "../routes/admin/invitations-detail";
import { action as invitationsAction } from "../routes/admin/invitations";
import { action as membershipDetailAction } from "../routes/admin/memberships-detail";
import { action as userDetailAction } from "../routes/admin/users-detail";
import { action as accountAction } from "../routes/marketplace/account";
import {
  action as accountConsentsAction,
  loader as accountConsentsLoader,
} from "../routes/marketplace/account-consents";
import { action as accountSecurityAction } from "../routes/marketplace/account-security";
import {
  action as accountShippingAddressesAction,
  loader as accountShippingAddressesLoader,
} from "../routes/marketplace/account-shipping-addresses";
import { action as accountTeamAction } from "../routes/marketplace/account-team";
import { IdentityApiError } from "../client";
import { syntheticMutationResult } from "../features/account-management/api/test-support";
import type { MutationAction } from "../features/account-management/domain/contract";

const actor = {
  sessionId: "ses_identity",
  tenantId: "tnt_identity",
  userId: "usr_identity",
  accountId: "acc_identity",
  membershipId: "mbr_identity",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view", "memberships.manage", "memberships.view", "security.manage"],
};

function identityCommit(position = "42") {
  return {
    commandReceipt: {
      mode: "eventual",
      commitPosition: position,
      commitEventIds: [`evt_identity_${position}`],
      commitPositions: [
        {
          sourceContextName: "identity",
          maxGlobalPosition: position,
          eventIds: [`evt_identity_${position}`],
        },
      ],
    },
  };
}

function commitHeaders(position = "42") {
  return {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_identity_${position}`,
    [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: position,
        eventIds: [`evt_identity_${position}`],
      },
    ]),
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function formRequest(path: string, form: Record<string, string>) {
  return new Request(`https://chasesets.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: "session=identity",
      ...(path.startsWith("/account")
        ? { "Idempotency-Key": "9230f01b-7871-420b-9c32-37139f80f749", Accept: "text/x-script" }
        : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

async function captureRedirect(actionCall: Promise<unknown>) {
  const response = (await actionCall) as Response;
  if (response.status === 200) {
    expect(response.headers.get("Location")).toBeNull();
    return (await response.json()).destination as string;
  }
  expect(response.status).toBe(302);
  return response.headers.get("Location") ?? "";
}

function participantReply(request: Request, secret?: string) {
  const parts = new URL(request.url).pathname.split("/");
  const last = parts.at(-1)!;
  let action: MutationAction;
  if (parts.includes("api-keys"))
    action = last === "api-keys" ? "create-api-key" : last === "rotate" ? "rotate-api-key" : "revoke-api-key";
  else if (parts.includes("invitations")) action = last === "invitations" ? "create-invitation" : "cancel-invitation";
  else if (parts.includes("memberships"))
    action = last === "role" ? "change-role" : last === "reinstate" ? "reinstate" : "revoke";
  else if (parts.includes("consents")) action = "withdraw";
  else if (parts.includes("shipping-addresses"))
    action =
      last === "shipping-addresses"
        ? "create"
        : last === "default"
          ? "default"
          : last === "archive"
            ? "archive"
            : "update";
  else action = parts.includes("users") ? "update-user" : "update-profile";
  return syntheticMutationResult(action, actor, {
    ...(secret && ["create-api-key", "rotate-api-key"].includes(action) ? { secret } : {}),
  });
}

function expectLocationPath(location: string, expectedPath: string | RegExp) {
  if (typeof expectedPath === "string") {
    const actual = new URL(location, "https://chasesets.test");
    const expected = new URL(expectedPath, "https://chasesets.test");
    expect(actual.pathname).toBe(expected.pathname);
    for (const [key, value] of expected.searchParams) {
      expect(actual.searchParams.get(key)).toBe(value);
    }
    expect(actual.searchParams.get("afterWrite")).toBeTruthy();
    return;
  }

  expect(location).toMatch(expectedPath);
  expect(location).toContain("?afterWrite=");
}

describe("Identity mutation consistency route actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves all ten marketplace successes and executes each request once", async () => {
    const cases = [
      {
        action: accountAction,
        path: "/account",
        form: { intent: "update-profile", name: "Store", displayName: "Store" },
      },
      {
        action: accountSecurityAction,
        path: "/account/security",
        form: { intent: "update-user", displayName: "Alex" },
      },
      { action: accountSecurityAction, path: "/account/security", form: { intent: "create-api-key", name: "Ops" } },
      {
        action: accountSecurityAction,
        path: "/account/security",
        form: { intent: "rotate-api-key", apiKeyId: "key_1" },
      },
      {
        action: accountSecurityAction,
        path: "/account/security",
        form: { intent: "revoke-api-key", apiKeyId: "key_1" },
      },
      {
        action: accountTeamAction,
        path: "/account/team",
        form: { intent: "create-invitation", email: "invitee@example.com", roleKey: "viewer" },
      },
      {
        action: accountTeamAction,
        path: "/account/team",
        form: { intent: "change-role", membershipId: "mbr_1", roleKey: "viewer" },
      },
      { action: accountTeamAction, path: "/account/team", form: { intent: "revoke", membershipId: "mbr_1" } },
      { action: accountTeamAction, path: "/account/team", form: { intent: "reinstate", membershipId: "mbr_1" } },
      {
        action: accountTeamAction,
        path: "/account/team",
        form: { intent: "cancel-invitation", invitationId: "ivt_1" },
      },
    ] as const;
    for (const testCase of cases) {
      const requests: string[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        requests.push(url);
        return url.includes("/api/auth/session")
          ? jsonResponse({ actor })
          : jsonResponse(
              syntheticMutationResult(testCase.form.intent, actor, {
                ...(["create-api-key", "rotate-api-key"].includes(testCase.form.intent)
                  ? { secret: "synthetic-secret" }
                  : {}),
              }),
              200,
              commitHeaders("79"),
            );
      });
      vi.stubGlobal("fetch", fetch);
      const response = await testCase.action({
        request: formRequest(testCase.path, testCase.form),
        params: {},
        context: undefined,
      });
      expect(response).toBeInstanceOf(Response);
      const result = response as Response;
      if (["create-api-key", "rotate-api-key"].includes(testCase.form.intent)) {
        expect(result.status).toBe(200);
        expect(result.headers.get("Location")).toBeNull();
        expect(await result.json()).toMatchObject({ outcome: "committed", secret: "synthetic-secret" });
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      } else {
        expect(result.status).toBe(200);
        expect(result.headers.get("Location")).toBeNull();
        const location = (await result.json()).destination;
        expectLocationPath(location, testCase.path);
        expect(readFreshWriteToken(`https://chasesets.test${location}`)?.commitPosition).toBe("79");
      }
      expect(requests.filter((url) => url.includes("/api/identity/"))).toHaveLength(1);
      expect(requests.filter((url) => url.includes("/acceptance-link/request"))).toHaveLength(
        testCase.form.intent === "create-invitation" ? 1 : 0,
      );
      expect(fetch).toHaveBeenCalledTimes(testCase.form.intent === "create-invitation" ? 3 : 2);
    }
  });

  it("reports committed delivery-unknown after one write even for admitted API lookalikes", async () => {
    const failures = [
      ...[400, 422].flatMap((status) =>
        ["validation_failed", "validation_error"].map((code) => new IdentityApiError(status, { error: { code } })),
      ),
      new IdentityApiError(404, { error: { code: "not_found" } }),
      new IdentityApiError(409, { error: { code: "conflict" } }),
      new TypeError("synthetic-delivery-network-error"),
    ];
    for (const failure of [...failures, null]) {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          requests.push(request);
          if (request.url.includes("/api/auth/session")) return jsonResponse({ actor });
          if (request.url.includes("/acceptance-link/request")) {
            if (failure) throw failure;
            return jsonResponse({ error: { code: "conflict" } }, 409);
          }
          return jsonResponse(syntheticMutationResult("create-invitation", actor), 200, commitHeaders("80"));
        }),
      );
      const call = accountTeamAction({
        request: formRequest("/account/team", {
          intent: "create-invitation",
          email: "invitee@example.com",
          roleKey: "viewer",
        }),
        params: {},
        context: undefined,
      });
      const response = (await call) as Response;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: "committed", delivery: "unknown" });
      const writes = requests.filter((request) => request.url.includes("/api/identity/invitations"));
      const deliveries = requests.filter((request) => request.url.includes("/acceptance-link/request"));
      expect(writes).toHaveLength(1);
      expect(deliveries).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(await deliveries[0].clone().json()).toMatchObject({ invitationId: "ivt_synthetic" });
    }
  });

  it("carries command receipts from owned post forms into fresh-read redirects", async () => {
    const lifecycleBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = request.url;

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor });
        }
        if (/\/api\/identity\/accounts\/acc_1\/(suspend|reactivate|close)$/.test(url)) {
          lifecycleBodies.push(await request.clone().json());
        }

        return jsonResponse(
          request.headers.has("Idempotency-Key")
            ? participantReply(request)
            : { id: "identity_written", version: 7, status: "active" },
          200,
          commitHeaders("77"),
        );
      }),
    );

    const cases = [
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "update-profile",
          name: "Card Vault LLC",
          displayName: "Card Vault",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "create-invitation",
          accountId: "acc_wrong",
          email: "invitee@example.com",
          roleKey: "viewer",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1?tab=team",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "assign-account-badge",
          badgeKey: "founding-account",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "remove-account-badge",
          badgeKey: "founding-account",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "assign-account-badge",
          badgeKey: "trusted-seller",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", {
          intent: "remove-account-badge",
          badgeKey: "trusted-seller",
        }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", { intent: "suspend" }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", { intent: "reactivate" }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: accountDetailAction,
        request: formRequest("/access/accounts/acc_1", { intent: "close" }),
        params: { id: "acc_1" },
        expectedPath: "/access/accounts/acc_1",
      },
      {
        action: invitationsAction,
        request: formRequest("/access/invitations", {
          intent: "create",
          accountId: "acc_identity",
          email: "invitee@example.com",
          roleKey: "viewer",
        }),
        params: {},
        expectedPath: /^\/access\/invitations\/ivt_[^?]+\?afterWrite=/,
      },
      {
        action: invitationDetailAction,
        request: formRequest("/access/invitations/ivt_1", { intent: "cancel" }),
        params: { id: "ivt_1" },
        expectedPath: "/access/invitations/ivt_1",
      },
      {
        action: membershipDetailAction,
        request: formRequest("/access/memberships/mbr_1", { intent: "change-role", roleKey: "manager" }),
        params: { id: "mbr_1" },
        expectedPath: "/access/memberships/mbr_1",
      },
      {
        action: membershipDetailAction,
        request: formRequest("/access/memberships/mbr_1", { intent: "revoke" }),
        params: { id: "mbr_1" },
        expectedPath: "/access/memberships/mbr_1",
      },
      {
        action: membershipDetailAction,
        request: formRequest("/access/memberships/mbr_1", { intent: "reinstate" }),
        params: { id: "mbr_1" },
        expectedPath: "/access/memberships/mbr_1",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "update-profile",
          displayName: "Alex Collector",
          givenName: "Alex",
          familyName: "Collector",
        }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", { intent: "suspend" }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", { intent: "reactivate" }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "add-contact-method",
          contactMethodType: "email",
          contactMethodValue: "alex@example.com",
        }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "verify-contact-method",
          contactMethodId: "ctm_1",
        }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "enable-auth-method",
          authMethod: "sms-code",
        }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "disable-auth-method",
          authMethod: "sms-code",
        }),
        params: { id: "usr_identity" },
        expectedPath: "/access/users/usr_identity",
      },
      {
        action: accountAction,
        request: formRequest("/account", {
          intent: "update-profile",
          name: "Card Vault LLC",
          displayName: "Card Vault",
        }),
        params: {},
        expectedPath: "/account",
      },
      {
        action: accountTeamAction,
        request: formRequest("/account/team", {
          intent: "create-invitation",
          email: "teammate@example.com",
          roleKey: "viewer",
        }),
        params: {},
        expectedPath: "/account/team",
      },
      {
        action: accountConsentsAction,
        request: formRequest("/account/consents", {
          intent: "withdraw",
          consentId: "cns_1",
        }),
        params: {},
        expectedPath: "/account/consents",
      },
      {
        action: accountShippingAddressesAction,
        request: formRequest("/account/shipping-addresses", {
          intent: "create",
          name: "Alex Collector",
          line1: "100 Main St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        }),
        params: {},
        expectedPath: "/account/shipping-addresses",
      },
    ] as const;

    for (const testCase of cases) {
      const location = await captureRedirect(
        testCase.action({
          request: testCase.request,
          params: testCase.params,
          context: undefined,
        } as never),
      );

      expectLocationPath(location, testCase.expectedPath);
      expect(readFreshWriteToken(`https://chasesets.test${location}`)?.commitPosition).toBe("77");
    }
    expect(lifecycleBodies).toEqual([{}, {}, {}]);
  });

  it("returns API-key create and rotate secrets as transient action data without redirecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor });
        }

        return jsonResponse(
          new Request(input, init).headers.has("Idempotency-Key")
            ? participantReply(new Request(input, init), "key_identity_full_secret_value")
            : {
                id: "key_identity_written",
                version: 7,
                status: "active",
                keyPrefix: "key_identity",
                secret: "key_identity_full_secret_value",
              },
          200,
          commitHeaders("78"),
        );
      }),
    );

    const cases = [
      {
        action: apiKeysAction,
        request: formRequest("/access/api-keys", { intent: "create", userId: "usr_identity", name: "Ops" }),
        params: {},
        status: 201,
        actionName: "created",
      },
      {
        action: apiKeyDetailAction,
        request: formRequest("/access/api-keys/key_1", { intent: "rotate" }),
        params: { id: "key_1" },
        status: 200,
        actionName: "rotated",
      },
      {
        action: userDetailAction,
        request: formRequest("/access/users/usr_identity", {
          intent: "create-api-key",
          userId: "usr_wrong",
          apiKeyName: "Ops",
        }),
        params: { id: "usr_identity" },
        status: 201,
        actionName: "created",
      },
      {
        action: accountSecurityAction,
        request: formRequest("/account/security", { intent: "create-api-key", name: "Storefront" }),
        params: {},
        status: 201,
        actionName: "created",
      },
      {
        action: accountSecurityAction,
        request: formRequest("/account/security", { intent: "rotate-api-key", apiKeyId: "key_1" }),
        params: {},
        status: 200,
        actionName: "rotated",
      },
    ] as const;

    for (const testCase of cases) {
      const response = (await testCase.action({
        request: testCase.request,
        params: testCase.params,
        context: undefined,
      } as never)) as Response;
      const body = (await response.json()) as {
        oneTimeSecret?: { apiKeyId?: string; keyPrefix?: string; secret?: string; action?: string };
      };

      expect(response.status).toBe(testCase.request.headers.has("Idempotency-Key") ? 200 : testCase.status);
      expect(response.headers.get("Location")).toBeNull();
      if (testCase.request.headers.has("Idempotency-Key"))
        expect(body).toMatchObject({ outcome: "committed", secret: "key_identity_full_secret_value" });
      else
        expect(body.oneTimeSecret).toEqual({
          apiKeyId: "key_identity_written",
          keyPrefix: "key_identity",
          secret: "key_identity_full_secret_value",
          action: testCase.actionName,
        });
    }
  });

  it("forwards fresh-read redirect receipts into Identity loader API reads", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/access-hub/accounts/acc_1")) {
          observedHeaders.push(new Headers(init?.headers));
          return jsonResponse({
            account: {
              account_id: "acc_1",
              account_type: "business",
              badges: [],
              display_name: "Card Vault",
              name: "Card Vault LLC",
              status: "active",
              updated_at: "2026-06-15T00:00:00.000Z",
            },
            users: [],
            memberships: [],
            invitations: [],
            api_keys: [],
            audit_events: [],
          });
        }

        return jsonResponse({ actor });
      }),
    );

    const nowMs = Date.now();
    const path = appendFreshWriteToken("/access/accounts/acc_1", identityCommit("88"), nowMs);
    await accountDetailLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: { id: "acc_1" },
      context: undefined,
    } as never);

    expect(observedHeaders).toHaveLength(1);
    expect(decodeFreshWriteReceipt(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), nowMs)).toMatchObject({
      commitPosition: "88",
      sources: [expect.objectContaining({ sourceContextName: "identity", maxGlobalPosition: "88" })],
    });
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("identity");
  });

  it("recovers account detail after post-write freshness timeout by retrying without freshness", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/access-hub/accounts/acc_1")) {
          observedHeaders.push(new Headers(init?.headers));
          if (observedHeaders.length === 1) {
            return jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection read model did not catch up before the freshness timeout.",
                },
              },
              503,
            );
          }

          return jsonResponse({
            account: {
              account_id: "acc_1",
              account_type: "business",
              badges: ["founding-account"],
              display_name: "Card Vault",
              name: "Card Vault LLC",
              status: "active",
              updated_at: "2026-06-15T00:00:00.000Z",
            },
            users: [],
            memberships: [],
            invitations: [],
            api_keys: [],
            audit_events: [],
          });
        }

        return jsonResponse({ actor });
      }),
    );

    const path = appendFreshWriteToken("/access/accounts/acc_1", identityCommit("93"));
    const data = await accountDetailLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: { id: "acc_1" },
      context: undefined,
    } as never);

    expect(data.data.account.badges).toEqual(["founding-account"]);
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(observedHeaders[1]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

  it("recovers invitation detail after post-write freshness timeout by retrying without freshness", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/invitations/ivt_1")) {
          observedHeaders.push(new Headers(init?.headers));
          if (observedHeaders.length === 1) {
            return jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection read model did not catch up before the freshness timeout.",
                },
              },
              503,
            );
          }

          return jsonResponse({
            invitation_id: "ivt_1",
            account_id: actor.accountId,
            email: "invitee@example.com",
            role_key: "viewer",
            status: "cancelled",
            expires_at: "2026-07-01T00:00:00.000Z",
            accepted_by_user_id: null,
            updated_at: "",
          });
        }

        return jsonResponse({ actor });
      }),
    );

    const path = appendFreshWriteToken("/access/invitations/ivt_1", identityCommit("92"));
    const response = await invitationDetailLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: { id: "ivt_1" },
      context: undefined,
    } as never);

    expect(response.headers.get("Location")).toBe(`/access/accounts/${actor.accountId}?tab=team&invitation=ivt_1`);
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(observedHeaders[1]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

  it("forwards shipping-address fresh-read receipts into the address-book API read", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/accounts/acc_identity/shipping-addresses")) {
          observedHeaders.push(new Headers(init?.headers));
          return jsonResponse({ items: [], total: 0, count: 0 });
        }

        return jsonResponse({ actor });
      }),
    );

    const nowMs = Date.now();
    const path = appendFreshWriteToken("/account/shipping-addresses", identityCommit("89"), nowMs);
    await accountShippingAddressesLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(observedHeaders).toHaveLength(1);
    expect(decodeFreshWriteReceipt(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), nowMs)).toMatchObject({
      commitPosition: "89",
      sources: [expect.objectContaining({ sourceContextName: "identity", maxGlobalPosition: "89" })],
    });
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("identity");
  });

  it("forwards consent-withdrawal fresh-read receipts into consent history reads", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/consents")) {
          observedHeaders.push(new Headers(init?.headers));
          return jsonResponse({ items: [], total: 0, count: 0 });
        }

        return jsonResponse({ actor });
      }),
    );

    const nowMs = Date.now();
    const path = appendFreshWriteToken("/account/consents", identityCommit("94"), nowMs);
    await accountConsentsLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(observedHeaders).toHaveLength(1);
    expect(decodeFreshWriteReceipt(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), nowMs)).toMatchObject({
      commitPosition: "94",
      sources: [expect.objectContaining({ sourceContextName: "identity", maxGlobalPosition: "94" })],
    });
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("identity");
  });

  it("keeps shipping-address management usable while the address projection catches up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/accounts/acc_identity/shipping-addresses")) {
          return jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          );
        }

        return jsonResponse({ actor });
      }),
    );

    const path = appendFreshWriteToken("/account/shipping-addresses", identityCommit("90"));
    const data = await accountShippingAddressesLoader({
      request: new Request(`https://chasesets.test${path}`, {
        headers: { cookie: "session=identity" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(data).toEqual({
      addresses: [],
      loadError: "Shipping addresses are still updating. Reload this page in a moment.",
      mutationActor: { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
    });
  });

  it("preserves expired shipping-address post-write failures as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/accounts/acc_identity/shipping-addresses")) {
          return jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          );
        }

        return jsonResponse({ actor });
      }),
    );

    const expiredPath = appendFreshWriteToken("/account/shipping-addresses", identityCommit("91"), 1);

    await expect(
      accountShippingAddressesLoader({
        request: new Request(`https://chasesets.test${expiredPath}`, {
          headers: { cookie: "session=identity" },
        }),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
        },
      },
    });
  });
});
