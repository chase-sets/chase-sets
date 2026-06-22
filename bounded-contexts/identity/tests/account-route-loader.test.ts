import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { loader } from "../routes/marketplace/account";

const actor = {
  sessionId: "ses_identity",
  tenantId: "tnt_identity",
  userId: "usr_identity",
  accountId: "acc_identity",
  membershipId: "mbr_identity",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

const actorDisplay = {
  account: {
    account_id: "acc_identity",
    badges: [],
    display_name: "Alex Collector",
    name: "Alex Collector",
  },
  membership: {
    membership_id: "mbr_identity",
    role_key: "owner",
  },
  user: {
    user_id: "usr_identity",
    display_name: "Alex Collector",
    primary_email: "alex@example.com",
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function accountRequest(path = "/account?authPrompt=add-passkey") {
  return new Request(`https://chasesets.test${path}`, {
    headers: { cookie: "session=identity" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function stubAccountLoaderFetch(accountResponse: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);

      if (url.includes("/api/auth/session")) {
        return jsonResponse({ actor });
      }

      if (url.includes("/api/identity/current-actor-display")) {
        return jsonResponse(actorDisplay);
      }

      if (url.includes("/api/identity/accounts/acc_identity")) {
        return accountResponse();
      }

      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

function accountNotFoundResponse() {
  return jsonResponse(
    {
      error: {
        code: "not_found",
        message: "Account not found.",
      },
    },
    404,
  );
}

describe("marketplace account route loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the post-registration account page usable with a temporary fallback while the account projection catches up", async () => {
    stubAccountLoaderFetch(accountNotFoundResponse);

    const path = appendFreshWriteToken("/account?authPrompt=add-passkey", identityCommit("51"));
    const data = await loader({
      request: accountRequest(path),
      params: {},
      context: undefined,
    } as never);

    expect(data).toEqual({
      account: {
        account_id: "acc_identity",
        account_type: "personal",
        badges: [],
        display_name: "Alex Collector",
        name: "Alex Collector",
        status: "active",
        updated_at: "",
      },
      accountRecovery: {
        kind: "temporary-actor-account-fallback",
        recoveryKind: "refreshable-catching-up",
      },
      actorDisplay,
    });
  });

  it("does not fabricate an actor fallback for account 404s without a fresh write receipt", async () => {
    stubAccountLoaderFetch(accountNotFoundResponse);

    await expect(
      loader({
        request: accountRequest(),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("does not fabricate an actor fallback for account 404s with an expired fresh write receipt", async () => {
    stubAccountLoaderFetch(accountNotFoundResponse);

    const expiredPath = appendFreshWriteToken("/account?authPrompt=add-passkey", identityCommit("52"), 1);

    await expect(
      loader({
        request: accountRequest(expiredPath),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("uses the shared temporary fallback for fresh projection timeout reads", async () => {
    stubAccountLoaderFetch(() =>
      jsonResponse(
        {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        },
        503,
      ),
    );

    const path = appendFreshWriteToken("/account?authPrompt=add-passkey", identityCommit("53"));
    const data = await loader({
      request: accountRequest(path),
      params: {},
      context: undefined,
    } as never);

    expect(data.accountRecovery).toEqual({
      kind: "temporary-actor-account-fallback",
      recoveryKind: "refreshable-catching-up",
    });
    expect(data.account.account_id).toBe("acc_identity");
  });

  it("uses the shared temporary fallback for fresh bounded gateway timeout reads", async () => {
    stubAccountLoaderFetch(() => jsonResponse({ error: { message: "Gateway timeout." } }, 504));

    const path = appendFreshWriteToken("/account?authPrompt=add-passkey", identityCommit("54"));
    const data = await loader({
      request: accountRequest(path),
      params: {},
      context: undefined,
    } as never);

    expect(data.accountRecovery).toEqual({
      kind: "temporary-actor-account-fallback",
      recoveryKind: "refreshable-catching-up",
    });
    expect(data.account.account_id).toBe("acc_identity");
  });

  it("still surfaces non-readiness account API failures", async () => {
    stubAccountLoaderFetch(() =>
      jsonResponse({ error: { code: "server_error", message: "Identity is unavailable." } }, 500),
    );

    await expect(
      loader({
        request: accountRequest(),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("still surfaces unclassified failures even with a fresh write receipt", async () => {
    stubAccountLoaderFetch(() =>
      jsonResponse({ error: { code: "server_error", message: "Identity is unavailable." } }, 500),
    );

    const path = appendFreshWriteToken("/account?authPrompt=add-passkey", identityCommit("55"));

    await expect(
      loader({
        request: accountRequest(path),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 500 });
  });
});
