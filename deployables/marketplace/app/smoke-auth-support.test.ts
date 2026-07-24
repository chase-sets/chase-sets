import { createServer, type ServerResponse } from "node:http";
import { encodeCommitReceipt } from "@chase-sets/http/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  privilegedRequest,
  projectionCheckpointResponseBodyLimitBytes,
  registerOrSignInSyntheticAccount,
  signInWithPassword,
} from "../e2e/support/auth";

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
      headers: { "content-type": "application/json", ...this.responseHeaders },
    });
  }
}

const emptyRegistrationConsentResolution = {
  operationId: "cmd_smoke_registration",
  snapshot: {
    bundleKey: "registration",
    requirements: [],
  },
} as const;

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
        if (url.endsWith("/api/auth/registration-consent")) {
          return new FakeResponse(200, emptyRegistrationConsentResolution);
        }
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

    expect(message).toBe("platform-admin password sign-in failed (network)");
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_EMAIL);
    expect(message).not.toContain(process.env.PLATFORM_ADMIN_PASSWORD);
    expect(message).not.toContain("arbitrary-transport-exception-secret");
  });

  it("reproduces the 64 KiB full-snapshot failure with a production-shaped response", async () => {
    const body = createProductionShapedProjectionSnapshot();
    expect(Buffer.byteLength(body)).toBe(65_719);

    await withNativeServer(
      (path, response) => {
        expect(path).toBe("/api/platform/projections/refresh");
        writeResponse(response, 200, body, { "content-type": "application/json" });
      },
      async (origin) => {
        const error = await privilegedRequest(origin, "/api/platform/projections/refresh", {
          method: "POST",
          expectedStatus: 200,
          operation: "platform admin projection refresh",
          responseBodyLimitBytes: 64 * 1024,
        }).catch((caught: unknown) => caught);

        expect(readErrorMessage(error)).toBe("platform admin projection refresh failed (response-too-large)");
      },
    );
  });

  it("bounds the minimal checkpoint response through the native privileged request path", async () => {
    const secretMarkers = ["body-secret-marker", "header-secret-marker", "exception-secret-marker"];
    let resolvePartialBodyConnectionClosed: (() => void) | undefined;
    const partialBodyConnectionClosed = new Promise<void>((resolve) => {
      resolvePartialBodyConnectionClosed = resolve;
    });
    await withNativeServer(
      (path, response) => {
        if (path === "/largest-valid") {
          return writeJsonResponse(response, 200, { lastGlobalPosition: "9223372036854775807" });
        }
        if (path === "/cap-plus-one") {
          return writeResponse(response, 200, "x".repeat(projectionCheckpointResponseBodyLimitBytes + 1), {
            "content-type": "application/json",
          });
        }
        if (path === "/chunked-cap-crossing") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("x".repeat(projectionCheckpointResponseBodyLimitBytes));
          response.end("x");
          return;
        }
        if (path === "/partial-endless") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"lastGlobalPosition":"');
          response.once("close", () => {
            resolvePartialBodyConnectionClosed?.();
          });
          return;
        }
        if (path === "/malformed") {
          return writeResponse(response, 200, '{"body-secret-marker":', { "content-type": "application/json" });
        }
        if (path === "/wrong-content-type") {
          return writeResponse(response, 200, "body-secret-marker", {
            "content-type": "text/plain",
            "x-secret": "header-secret-marker",
          });
        }
        if (path === "/wrong-status") {
          return writeJsonResponse(response, 502, {
            error: "body-secret-marker",
            exception: "exception-secret-marker",
          });
        }
        throw new Error("unexpected native-server path");
      },
      async (origin) => {
        const request = (path: string, timeoutMs = 1_000) =>
          privilegedRequest(origin, path, {
            method: "POST",
            expectedStatus: 200,
            operation: "platform admin projection refresh",
            responseBodyLimitBytes: projectionCheckpointResponseBodyLimitBytes,
            timeoutMs,
          });

        await expect(request("/largest-valid")).resolves.toMatchObject({
          body: { lastGlobalPosition: "9223372036854775807" },
        });

        const controls = [
          ["/cap-plus-one", "response-too-large", 1_000],
          ["/chunked-cap-crossing", "response-too-large", 1_000],
          ["/partial-endless", "timeout", 100],
          ["/malformed", "invalid-json", 1_000],
          ["/wrong-content-type", "unexpected-content-type", 1_000],
          ["/wrong-status", "unexpected-status", 1_000],
        ] as const;
        for (const [path, classification, timeoutMs] of controls) {
          const startedAt = Date.now();
          const error = await request(path, timeoutMs).catch((caught: unknown) => caught);
          const message = readErrorMessage(error);
          expect(message).toBe(`platform admin projection refresh failed (${classification})`);
          expect(Date.now() - startedAt).toBeLessThan(2_000);
          for (const marker of secretMarkers) {
            expect(message).not.toContain(marker);
          }
          if (path === "/partial-endless") {
            await expect(waitForSignal(partialBodyConnectionClosed, 1_000)).resolves.toBeUndefined();
          }
        }
      },
    );
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
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        expect(call.headers?.cookie).toBe("chase_sets_session=admin_session");
        expect(call.data).toEqual({
          targetContextName: "auth",
          projectionName: "auth-identity-invitation-projection",
          sourceContextName: "identity",
        });
        return new FakeResponse(200, { lastGlobalPosition: "42" });
      }
      throw new Error(`Unexpected privileged request: ${call.method} ${call.url}`);
    });
    const { calls, cookies, page } = createFakePage((call) => {
      if (call.url.endsWith("/api/auth/register")) {
        expect(call.data).toMatchObject({
          email: account.email,
          password: account.password,
          registrationConsent: {
            ...emptyRegistrationConsentResolution,
            affirmed: false,
          },
        });
        return new FakeResponse(201, { sessionToken: "synthetic_session" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await expect(registerOrSignInSyntheticAccount(page, "https://marketplace.test", account)).resolves.toBe(
      "synthetic_session",
    );

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh-checkpoint",
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
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        return new FakeResponse(200, { lastGlobalPosition: "43" });
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
      if (call.url.endsWith("/api/platform/projections/refresh-checkpoint")) {
        return new FakeResponse(200, { lastGlobalPosition: "44" });
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

    expect(calls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/registration-consent",
      "/api/auth/register",
    ]);
    expect(privilegedCalls.map((call) => call.url.replace("https://marketplace.test", ""))).toEqual([
      "/api/auth/password-sign-in",
      "/api/identity/current-actor-display",
      "/api/identity/invitations",
      "/api/platform/projections/refresh-checkpoint",
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

    expect(calls).toHaveLength(2);
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

function createProductionShapedProjectionSnapshot() {
  const projectionGroups = [];
  let body = "";
  for (let index = 0; Buffer.byteLength(body) <= 64 * 1024; index += 1) {
    projectionGroups.push({
      projectionName: `production-projection-${index}`,
      projectionRevision: 3,
      storedProjectionRevision: 3,
      revisionStale: false,
      targetContextName: `production-context-${index % 20}`,
      sourceContextNames: ["identity", "marketplace"],
      ownedTables: [`production_projection_${index}`],
      requiredDuringBootstrap: true,
      initialized: true,
      caughtUp: true,
      state: "caught-up",
      lastError: null,
      outstandingEventCount: "0",
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: "2026-07-22T23:20:00.000Z",
      subscriptions: [
        {
          checkpointKey: `production-projection-${index}:identity:v3`,
          subscriptionName: `production-projection-${index}`,
          projectionName: `production-projection-${index}`,
          sourceContextName: "identity",
          targetContextName: `production-context-${index % 20}`,
          subscriptionVersion: 3,
          initialized: true,
          lastGlobalPosition: "29965633335",
          sourceHeadGlobalPosition: "29965633335",
          outstandingEventCount: "0",
          processedEvents: 0,
          state: "caught-up",
          lastError: null,
          blockedStreamCount: 0,
          poisonEventCount: 0,
          updatedAt: "2026-07-22T23:20:00.000Z",
        },
      ],
    });
    body = JSON.stringify({
      summary: { status: "ok", totalGroups: projectionGroups.length },
      projectionGroups,
      projectionStatusSource: "live-refresh",
    });
  }
  return body;
}

async function withNativeServer(
  route: (path: string, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    route(new URL(request.url ?? "/", "http://native.test").pathname, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("native server failed (listen)");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function writeJsonResponse(response: ServerResponse, status: number, body: unknown) {
  writeResponse(response, status, JSON.stringify(body), { "content-type": "application/json" });
}

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
) {
  response.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function waitForSignal(signal: Promise<void>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("native server signal timed out")), timeoutMs);
    void signal.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
