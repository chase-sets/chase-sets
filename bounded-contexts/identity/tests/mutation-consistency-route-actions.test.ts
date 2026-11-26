import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { SHIPPING_ADDRESS_REQUIRED_MESSAGES } from "../features/shipping-addresses/domain/errors";
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
  else if (parts.includes("invitations"))
    action =
      last === "invitations" ? "create-invitation" : last === "resend" ? "resend-invitation" : "cancel-invitation";
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
});
