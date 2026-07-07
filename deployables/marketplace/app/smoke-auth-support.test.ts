import { encodeCommitReceipt } from "@chase-sets/http/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOrSignInSyntheticAccount } from "../e2e/support/auth";

type RequestCall = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}>;

type FakeRoute = (call: RequestCall) => FakeResponse | Promise<FakeResponse>;

class FakeResponse {
  public constructor(
    private readonly statusCode: number,
    private readonly body: unknown = {},
    private readonly responseHeaders: Record<string, string> = {},
  ) {}

  public status() {
    return this.statusCode;
  }

  public async json() {
    return this.body;
  }

  public headers() {
    return this.responseHeaders;
  }
}

function createFakePage(route: FakeRoute) {
  const calls: RequestCall[] = [];
  const cookies: { name: string; value: string }[] = [];
  const page = {
    request: {
      post: vi.fn(async (url: string, options: { headers?: Record<string, string>; data?: unknown } = {}) => {
        const call = { method: "POST", url, headers: options.headers, data: options.data } as const;
        calls.push(call);
        return route(call);
      }),
      get: vi.fn(async (url: string, options: { headers?: Record<string, string> } = {}) => {
        const call = { method: "GET", url, headers: options.headers } as const;
        calls.push(call);
        return route(call);
      }),
    },
    context: () => ({
      addCookies: vi.fn(async (newCookies: { name: string; value: string }[]) => {
        cookies.push(...newCookies);
      }),
      cookies: vi.fn(async () => cookies),
    }),
    waitForTimeout: vi.fn(async () => undefined),
  };

  return { calls, cookies, page: page as never };
}

const account = {
  email: "critical-flow-run@example.test",
  password: "synthetic-password",
  displayName: "Critical Flow Run",
};

function withPlatformAdminEnv() {
  process.env.PLATFORM_ADMIN_EMAIL = "platform-admin@example.test";
  process.env.PLATFORM_ADMIN_PASSWORD = "platform-admin-password";
}

afterEach(() => {
  delete process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.PLATFORM_ADMIN_PASSWORD;
});

describe("marketplace smoke auth support", () => {
  it("provisions a pending invitation through the platform admin before registering a synthetic account", async () => {
    withPlatformAdminEnv();
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "42",
        eventIds: ["evt_invitation"],
      },
    ]);
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        expect(call.data).toMatchObject({
          accountId: "acc_platform",
          email: account.email,
          roleKey: "viewer",
        });
        return new FakeResponse(
          201,
          { id: "ivt_smoke", status: "pending" },
          {
            "chase-sets-commit-receipt": invitationReceipt,
          },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh")) {
        expect(call.headers?.Cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, {
          projectionGroups: [
            {
              targetContextName: "auth",
              projectionName: "auth-identity-invitation-projection",
              subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: "42" }],
            },
          ],
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
      "/api/auth/register",
    ]);
    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });

  it("keeps the existing-account sign-in fallback after invitation provisioning", async () => {
    withPlatformAdminEnv();
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "43",
        eventIds: ["evt_invitation"],
      },
    ]);
    const { cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        const email = (call.data as { email?: string }).email;
        return new FakeResponse(200, { sessionToken: email === account.email ? "synthetic_session" : "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        return new FakeResponse(
          201,
          { id: "ivt_smoke", status: "pending" },
          {
            "chase-sets-commit-receipt": invitationReceipt,
          },
        );
      }
      if (call.url.endsWith("/api/platform/projections/refresh")) {
        return new FakeResponse(200, {
          projectionGroups: [
            {
              targetContextName: "auth",
              projectionName: "auth-identity-invitation-projection",
              subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: "43" }],
            },
          ],
        });
      }
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(409, { error: "User exists." });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });

  it("preserves direct registration for local open-admission environments without platform-admin credentials", async () => {
    const { calls, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls).toHaveLength(1);
  });

  it("signs in an already-provisioned account when a gated environment lacks admin credentials", async () => {
    const { cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(403, { error: { code: "registration_admission_required" } });
      }
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });
});
