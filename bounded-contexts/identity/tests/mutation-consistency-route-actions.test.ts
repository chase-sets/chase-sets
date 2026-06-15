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
import { action as invitationDetailAction } from "../routes/admin/invitations-detail";
import { action as invitationsAction } from "../routes/admin/invitations";
import { action as membershipDetailAction } from "../routes/admin/memberships-detail";
import { action as userDetailAction } from "../routes/admin/users-detail";
import { action as accountAction } from "../routes/marketplace/account";
import { action as accountSecurityAction } from "../routes/marketplace/account-security";
import { action as accountShippingAddressesAction } from "../routes/marketplace/account-shipping-addresses";
import { action as accountTeamAction } from "../routes/marketplace/account-team";

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
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: "session=identity" },
    body: new URLSearchParams(form).toString(),
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

async function captureRedirect(actionCall: Promise<unknown>) {
  const response = (await actionCall) as Response;
  expect(response.status).toBe(302);
  return response.headers.get("Location") ?? "";
}

describe("Identity mutation consistency route actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries command receipts from owned post forms into fresh-read redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor });
        }

        return jsonResponse({ id: "identity_written", version: 7, status: "active" }, 200, commitHeaders("77"));
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
        action: apiKeysAction,
        request: formRequest("/access/api-keys", { intent: "create", userId: "usr_identity", name: "Ops" }),
        params: {},
        expectedPath: "/access/api-keys",
      },
      {
        action: apiKeyDetailAction,
        request: formRequest("/access/api-keys/key_1", { intent: "rotate" }),
        params: { id: "key_1" },
        expectedPath: "/access/api-keys/key_1",
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
        expectedPath: "/access/invitations",
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
        action: accountSecurityAction,
        request: formRequest("/account/security", { intent: "create-api-key", name: "Storefront" }),
        params: {},
        expectedPath: "/account/security",
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

      expect(location).toContain(`${testCase.expectedPath}?afterWrite=`);
      expect(readFreshWriteToken(`https://chasesets.test${location}`)?.commitPosition).toBe("77");
    }
  });

  it("forwards fresh-read redirect receipts into Identity loader API reads", async () => {
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/identity/accounts/acc_1")) {
          observedHeaders.push(new Headers(init?.headers));
          return jsonResponse({
            account_id: "acc_1",
            account_type: "business",
            badges: [],
            display_name: "Card Vault",
            name: "Card Vault LLC",
            status: "active",
            updated_at: "2026-06-15T00:00:00.000Z",
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
});
