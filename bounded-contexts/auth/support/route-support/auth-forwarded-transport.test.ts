import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  CHASE_SETS_INTERNAL_API_ORIGIN_ENV,
  CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV,
} from "@chase-sets/platform-runtime/http";
import type { AuthApiEnv } from "../api-support/support";
import type { AuthServices } from "../runtime-support/services";
import { defineAuthHost } from "./auth-host";
import { adminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";
import { createMagicLinkLandingLoader } from "./magic-link-landing";

const { getCredential, startInteractiveAuth } = vi.hoisted(() => ({
  getCredential: vi.fn(),
  startInteractiveAuth: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({ getPasswordCredentialByUserId: getCredential }));
vi.mock("../runtime-support/services", () => ({ startInteractiveAuth }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "http://platform-api.internal:8080");
  vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
  vi.stubEnv("CHASE_SETS_RATE_LIMITS_DISABLED", "false");
  getCredential.mockResolvedValue({
    credential_id: "pwd_synthetic",
    user_id: "usr_synthetic",
    secret_hash: "synthetic",
  });
  startInteractiveAuth.mockResolvedValue({
    type: "session-started",
    sessionToken: "synthetic-session",
    session: { expires_at: "2026-10-28T13:00:00Z" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const hosts = [marketplaceAuthHostConfig, adminAuthHostConfig];

function hostRequest(signInPath: string, address: string, fields: Record<string, string>) {
  return new Request(`https://host.chasesets.test${signInPath}`, {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.250, ${address}, 10.0.0.2` },
    body: new URLSearchParams(fields),
  });
}

function actionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: "/*",
  };
}

describe.each(hosts)("$hostLabel forwarded Auth transport", (config) => {
  it("forwarded password failures stay per client", async () => {
    // A new route module creates isolated real limiter state after installing the deterministic clock.
    const { registerPasswordRoutes } = await import("../api-support/password-routes");
    const services = {
      db: {},
      identity: {
        normalizeEmail: (email: string) => email.trim().toLowerCase(),
        getUserByEmail: async () => ({ user_id: "usr_synthetic" }),
      },
      auth: { verifyPassword: vi.fn(async (password: string) => ({ valid: password === "valid-synthetic" })) },
    };
    const app = createTestApp<AuthApiEnv>({
      actor: createAnonymousTestActor(),
      context: createTestEventStoreContext(createInternalSystemTestActor()),
      routes: (routes) => registerPasswordRoutes(routes.basePath("/api/auth"), services as unknown as AuthServices),
    });
    const captured: Array<{ address: string | null; status: number; surface?: string }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("http://platform-api.internal:8080/api/auth/password-sign-in");
      const response = await app.fetch(request);
      const body = await response.clone().json();
      captured.push({
        address: request.headers.get("x-forwarded-for"),
        status: response.status,
        surface: body.error?.surface,
      });
      return response;
    };
    vi.stubGlobal("fetch", fetchImpl);
    const action = defineAuthHost(config).createSignInAction();
    const signIn = (address: string, email: string, password: string) =>
      action(actionArgs(hostRequest(config.signInPath, address, { email, password })));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn("198.51.100.10", `a-${attempt}@example.test`, "wrong-synthetic");
      expect(captured.at(-1)?.status).toBe(401);
    }
    const success = await signIn("198.51.100.11", "b@example.test", "valid-synthetic");
    expect(captured.at(-1)).toMatchObject({ address: "198.51.100.11", status: 200 });
    expect(success).toBeInstanceOf(Response);
    expect((success as Response).status).toBe(302);
    expect((success as Response).headers.get("Location")).toBe(config.defaultSuccessPath);
    await signIn("198.51.100.10", "a-valid@example.test", "valid-synthetic");
    expect(captured.at(-1)).toMatchObject({ status: 429, surface: "auth.sign-in.ip-failures" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(`198.51.100.${20 + attempt}`, "same@example.test", "wrong-synthetic");
      expect(captured.at(-1)?.status).toBe(401);
    }
    await signIn("198.51.100.30", "same@example.test", "valid-synthetic");
    expect(captured.at(-1)).toMatchObject({ status: 429, surface: "auth.sign-in.identifier-failures" });
    vi.setSystemTime(new Date("2026-10-28T12:05:00Z"));
    await signIn("198.51.100.10", "a-valid@example.test", "valid-synthetic");
    expect(captured.at(-1)?.status).toBe(200);
  });

  it("Auth forwarded transport caller matrix", async () => {
    const calls: Array<{ path: string; address: string | null }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({ path: new URL(request.url).pathname, address: request.headers.get("x-forwarded-for") });
      return Response.json({
        type: "session-started",
        sessionToken: "synthetic-session",
        session: { expires_at: "2026-10-28T13:00:00Z" },
        tokenId: "synthetic-challenge",
        phone: "+15005550006",
        expiresAt: "2026-10-28T12:05:00Z",
      });
    };
    vi.stubGlobal("fetch", fetchImpl);
    const action = defineAuthHost(config).createSignInAction();
    const cases: Array<{ fields: Record<string, string>; path: string }> = [
      {
        fields: { intent: "password", email: "synthetic@example.test", password: "valid-synthetic" },
        path: "/api/auth/password-sign-in",
      },
      {
        fields: { intent: "magic-link-request", email: "synthetic@example.test" },
        path: "/api/auth/magic-link/request",
      },
      { fields: { intent: "phone-code-request", phone: "+15005550006" }, path: "/api/auth/phone-code/request" },
      {
        fields: { intent: "phone-code-consume", phone: "+15005550006", tokenId: "synthetic-challenge", code: "000000" },
        path: "/api/auth/phone-code/consume",
      },
    ];
    for (const row of cases) {
      await action(actionArgs(hostRequest(config.signInPath, "198.51.100.12", row.fields)));
      expect(calls.at(-1)).toEqual({ path: row.path, address: "198.51.100.12" });
    }
    const landing = createMagicLinkLandingLoader({ authHost: defineAuthHost(config), signInPath: config.signInPath });
    const result = await landing(
      actionArgs(
        new Request(`https://host.chasesets.test${config.signInPath}/magic?token=synthetic-token`, {
          headers: { "x-forwarded-for": "203.0.113.250, 198.51.100.12, 10.0.0.2" },
        }),
      ),
    );
    expect(result).toBeInstanceOf(Response);
    expect(calls.at(-1)).toEqual({ path: "/api/auth/magic-link/consume", address: "198.51.100.12" });
  });
});
