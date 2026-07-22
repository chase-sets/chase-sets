import { encodeCommitReceipt } from "@chase-sets/http/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "../e2e/support/auth";

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

  public toFetchResponse() {
    return new Response(JSON.stringify(this.body), {
      status: this.statusCode,
      headers: this.responseHeaders,
    });
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

function stubPrivilegedFetch(route: FakeRoute) {
  const calls: RequestCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : input.toString();
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const data = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const call = {
        method: init.method === "GET" ? "GET" : "POST",
        url,
        headers,
        data,
      } as const;
      calls.push(call);
      return (await route(call)).toFetchResponse();
    }),
  );
  return calls;
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
  delete process.env.TF_VAR_platform_admin_email;
  delete process.env.TF_VAR_platform_admin_password;
  vi.unstubAllGlobals();
});

describe("marketplace smoke auth support", () => {
  it("reports a bounded account fingerprint and status without credential or response markers", async () => {
    const adversarialAccount = {
      email: "email-secret-marker@example.test",
      password: "password-secret-marker",
    };
    const { page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(401, {
          authorization: "authorization-secret-marker",
          token: "token-secret-marker",
        });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const error = await signInWithPassword(page, "https://marketplace.test", adversarialAccount).catch(
      (caught: unknown) => caught,
    );
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toMatch(/account=sha256:[0-9a-f]{12}, status=401/);
    expect(message).not.toContain(adversarialAccount.email);
    expect(message).not.toContain(adversarialAccount.password);
    expect(message).not.toContain("authorization-secret-marker");
    expect(message).not.toContain("token-secret-marker");
  });

  it("classifies privileged transport failures without credential or exception text", async () => {
    process.env.PLATFORM_ADMIN_EMAIL = "privileged-email-secret@example.invalid";
    process.env.PLATFORM_ADMIN_PASSWORD = "privileged-password-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("arbitrary-transport-exception-secret");
      }),
    );
    const { page } = createFakePage(() => {
      throw new Error("Playwright request transport must not be reached");
    });

    const error = await registerOrSignInSyntheticAccount(page, "https://marketplace.test", account).catch(
      (caught: unknown) => caught,
    );
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toBe("platform admin setup failed (network)");
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_EMAIL);
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_PASSWORD);
    expect(message).not.toContain("arbitrary-transport-exception-secret");
  });

  it("provisions a pending invitation through the platform admin before registering a synthetic account", async () => {
    withPlatformAdminEnv();
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "42",
        eventIds: ["evt_invitation"],
      },
    ]);
    const privilegedCalls = stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
      }
      if (call.url.endsWith("/api/identity/current-actor-display")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
        return new FakeResponse(200, { account: { account_id: "acc_platform" } });
      }
      if (call.url.endsWith("/api/identity/invitations")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
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
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
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
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({
          email: account.email,
          password: account.password,
        });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual(["/api/auth/register"]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
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
    stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        return new FakeResponse(200, { sessionToken: "admin_session" });
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
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        return new FakeResponse(409, { error: "User exists." });
      }
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        expect(call.data).toMatchObject({ email: account.email, password: account.password });
        return new FakeResponse(200, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(cookies).toContainEqual(expect.objectContaining({ name: "chase_sets_session", value: "synthetic_session" }));
  });

  it("uses Terraform deploy admin credentials to provision gated synthetic accounts", async () => {
    process.env.TF_VAR_platform_admin_email = "platform-admin@example.test";
    process.env.TF_VAR_platform_admin_password = "platform-admin-password";
    const invitationReceipt = encodeCommitReceipt([
      {
        sourceContextName: "identity",
        maxGlobalPosition: "44",
        eventIds: ["evt_invitation"],
      },
    ]);
    const privilegedCalls = stubPrivilegedFetch((call) => {
      if (call.url.endsWith("/api/auth/password-sign-in")) {
        expect(call.data).toMatchObject({
          email: "platform-admin@example.test",
          password: "platform-admin-password",
        });
        return new FakeResponse(200, { sessionToken: "admin_session" });
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
              subscriptions: [{ sourceContextName: "identity", lastGlobalPosition: "44" }],
            },
          ],
        });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({ password: account.password });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual(["/api/auth/register"]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh",
    ]);
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
