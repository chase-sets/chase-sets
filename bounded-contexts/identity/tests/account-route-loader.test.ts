import { afterEach, describe, expect, it, vi } from "vitest";
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

function accountRequest(path = "/account?authPrompt=add-passkey") {
  return new Request(`https://chasesets.test${path}`, {
    headers: { cookie: "session=identity" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

describe("marketplace account route loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the post-registration account page usable while the account projection catches up", async () => {
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

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const data = await loader({
      request: accountRequest(),
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
      actorDisplay,
    });
  });

  it("still surfaces non-readiness account API failures", async () => {
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
          return jsonResponse({ error: { code: "server_error", message: "Identity is unavailable." } }, 500);
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await expect(
      loader({
        request: accountRequest(),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 500 });
  });
});
