import {
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../../../support/runtime-support/services";
import { createAuthServices } from "../../../support/runtime-support/services";
import contextManifest from "../../../context.json" with { type: "json" };
import type { AuthApiEnv } from "../../../support/api-support/support";
import { buildAuthApi } from "../../../api";

const secret = "cs_stg_persona_synthetic_secret";
const verifier = createHash("sha256").update(secret).digest("hex");
const origin = "https://marketplace.staging.chasesets.com";

const { limiters } = vi.hoisted(() => ({
  limiters: [] as { surface: string; check: ReturnType<typeof vi.fn>; clear: () => void }[],
}));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
vi.mock("@chase-sets/platform-runtime/http", async (original) => {
  const actual = await original<typeof import("@chase-sets/platform-runtime/http")>();
  return { ...actual, resolvePublicRequestOrigin: vi.fn(actual.resolvePublicRequestOrigin) };
});
vi.mock("@chase-sets/http/rate-limit", async (original) => {
  const actual = await original<typeof import("@chase-sets/http/rate-limit")>();
  return {
    ...actual,
    createConfiguredInMemoryRateLimiter: (...args: Parameters<typeof actual.createConfiguredInMemoryRateLimiter>) => {
      const limiter = actual.createConfiguredInMemoryRateLimiter(...args);
      const check = vi.fn(limiter.check);
      limiters.push({ surface: args[0], check, clear: limiter.clear });
      return { ...limiter, check };
    },
  };
});
vi.mock("../../../support/runtime-support/services", async (original) => ({
  ...(await original<typeof import("../../../support/runtime-support/services")>()),
  startInteractiveAuth: vi.fn(async () => ({
    type: "session-started",
    userId: "usr_repr_card_vault_user",
    sessionId: "ses_synthetic",
    sessionToken: "synthetic-session-token",
    memberships: [],
    session: { session_id: "ses_synthetic", expires_at: new Date(Date.now() + 60_000).toISOString() },
  })),
}));
vi.mock("@chase-sets/identity/server", async (original) => ({
  ...(await original<typeof import("@chase-sets/identity/server")>()),
  createIdentityAuthRequestClient: () => ({
    verifyEmailContactMethod: async () => ({ ok: true, userId: "usr_repr_card_vault_user", snapshots: [] }),
  }),
}));

function services(overrides: Partial<AuthServices> = {}) {
  return {
    db: { query: vi.fn(async () => ({ rows: [] })) },
    auth: {
      issueOpaqueToken: vi.fn(() => "magic-link-token"),
      hashSecret: vi.fn((value: string) => `hash:${value}`),
    },
    identity: {
      getUser: vi.fn(async () => ({
        user_id: "usr_repr_card_vault_user",
        status: "active",
        auth_methods: ["magic-link"],
        primary_email: "staging-card-vault@chasesets.test",
      })),
      getActiveMembershipForUserAccount: vi.fn(async () => ({ status: "active" })),
    },
    stagingPersonaMagicLinkVerifierSha256: verifier,
    eventStore: { appendToStream: vi.fn(async () => undefined) },
    notificationOutbox: { enqueueNotification: vi.fn(async () => undefined) },
    ...overrides,
  } as unknown as AuthServices;
}

function appFor(input: AuthServices) {
  return createTestApp<AuthApiEnv>({
    actor: null,
    context: createTestEventStoreContext(createInternalSystemTestActor()),
    routes: (app) => app.route("/", buildAuthApi(input)),
  });
}

function requestHeaders(bearer = secret, requestOrigin = origin) {
  return {
    origin: requestOrigin,
    host: "marketplace.staging.chasesets.com",
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  for (const limiter of limiters) {
    limiter.clear();
    limiter.check.mockClear();
  }
  vi.mocked(timingSafeEqual).mockClear();
});

function post(
  input: AuthServices,
  alias = "card-vault",
  headers: Record<string, string> = requestHeaders(),
  url = origin,
) {
  return appFor(input).request(`${url}/staging-persona-sign-in`, {
    method: "POST",
    headers,
    body: JSON.stringify({ alias }),
  });
}
function noWrites(input: AuthServices) {
  expect(input.db.query).not.toHaveBeenCalled();
  expect(input.auth.issueOpaqueToken).not.toHaveBeenCalled();
  expect(input.eventStore.appendToStream).not.toHaveBeenCalled();
  expect(input.notificationOutbox.enqueueNotification).not.toHaveBeenCalled();
}

describe("staging persona sign-in", () => {
  it("mounts from the manifest-admitted host verifier without requiring a session", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const input = createAuthServices({ query, connect: vi.fn() } as never, {
      stagingPersonaMagicLinkVerifierSha256: contextManifest.hostPorts.some(
        (port) => port.portName === "stagingPersonaMagicLinkVerifierSha256",
      )
        ? verifier
        : undefined,
    });
    expect((await post(input, "not-a-persona", requestHeaders("wrong-bearer"))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(contextManifest.anonymousRoutes).toContainEqual({
      routePath: "/api/auth/staging-persona-sign-in",
      methods: ["POST"],
    });
  });

  it("is not mounted without the staging verifier", async () => {
    const response = await appFor(services({ stagingPersonaMagicLinkVerifierSha256: undefined })).request(
      `${origin}/staging-persona-sign-in`,
      { method: "POST", headers: requestHeaders(), body: JSON.stringify({ alias: "card-vault" }) },
    );
    expect(response.status).toBe(404);
  });

  it("enforces Origin and Host before reading the bearer", async () => {
    const input = services();
    const response = await appFor(input).request(`${origin}/staging-persona-sign-in`, {
      method: "POST",
      headers: requestHeaders(secret, "https://evil.example"),
      body: JSON.stringify({ alias: "card-vault" }),
    });
    expect(response.status).toBe(403);
    expect(timingSafeEqual).not.toHaveBeenCalled();
    expect(input.auth.hashSecret).not.toHaveBeenCalled();
  });

  it("rejects a bad verifier and unsupported alias without Auth writes", async () => {
    const input = services();
    const response = await appFor(input).request(`${origin}/staging-persona-sign-in`, {
      method: "POST",
      headers: requestHeaders("wrong-bearer"),
      body: JSON.stringify({ alias: "not-a-persona" }),
    });
    expect(response.status).toBe(401);
    expect(input.db.query).not.toHaveBeenCalled();
    noWrites(input);
  });

  it("issues a ten-minute hash-only link for an Auth-owned alias", async () => {
    const input = services();
    const response = await appFor(input).request(`${origin}/staging-persona-sign-in`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ alias: "card-vault" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { alias: string; link: string; expiresAt: string };
    expect(body.alias).toBe("card-vault");
    expect(new URL(body.link).pathname).toBe("/sign-in/magic");
    expect(new URL(body.link).origin).toBe(origin);
    expect(body.expiresAt).toBeTruthy();
    const expiry = Date.parse(body.expiresAt);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(input.auth.issueOpaqueToken).toHaveBeenCalledWith("magic");
  });

  it("stores only the token hash and a null delivery token", async () => {
    const input = services();
    const response = await post(input);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { expiresAt: string };
    expect(input.db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO identity_magic_link_tokens"), [
      expect.any(String),
      "usr_repr_card_vault_user",
      "staging-card-vault@chasesets.test",
      "hash:magic-link-token",
      null,
      body.expiresAt,
    ]);
  });

  it("issues without an event or mail delivery", async () => {
    const input = services();
    expect((await post(input)).status).toBe(200);
    expect(input.eventStore.appendToStream).not.toHaveBeenCalled();
    expect(input.notificationOutbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign", "host", "missing-host", "resolved-origin-control", "forwarded"])(
    "refuses %s Origin/Host before the actual verifier primitive",
    async (mode) => {
      const input = services();
      const headers: Record<string, string> = requestHeaders();
      if (mode === "missing") delete headers.origin;
      if (mode === "foreign") headers.origin = "https://admin.staging.chasesets.com";
      if (mode === "host") headers.host = "admin.staging.chasesets.com";
      if (mode === "missing-host") delete headers.host;
      if (mode === "forwarded") {
        headers.origin = "https://foreign.invalid";
        headers["x-forwarded-host"] = new URL(origin).host;
        headers["x-forwarded-proto"] = "https";
      }
      if (mode === "resolved-origin-control")
        vi.mocked(resolvePublicRequestOrigin).mockReturnValueOnce("https://foreign.invalid");
      const response = await post(input, "card-vault", headers);
      expect(response.status).toBe(403);
      expect(timingSafeEqual).not.toHaveBeenCalled();
      expect(
        limiters
          .filter((limiter) => limiter.surface.startsWith("auth.staging-persona"))
          .every((limiter) => limiter.check.mock.calls.length === 0),
      ).toBe(true);
      noWrites(input);
    },
  );

  it("reaches the alias guard with a valid bearer and refuses an unlisted alias", async () => {
    const input = services();
    const response = await post(input, "not-a-persona");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "alias-refused" });
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(input.identity.getUser).not.toHaveBeenCalled();
    noWrites(input);
  });

  it.each(["inactive-user", "non-magic-user", "missing-user", "inactive-membership", "missing-membership"])(
    "refuses %s readiness without writes",
    async (mode) => {
      const input = services();
      if (mode === "missing-user") vi.mocked(input.identity.getUser).mockResolvedValue(null);
      if (mode === "inactive-user" || mode === "non-magic-user")
        vi.mocked(input.identity.getUser).mockResolvedValue({
          status: mode === "inactive-user" ? "suspended" : "active",
          auth_methods: mode === "non-magic-user" ? ["password"] : ["magic-link"],
        } as never);
      if (mode === "inactive-membership")
        vi.mocked(input.identity.getActiveMembershipForUserAccount).mockResolvedValue({ status: "revoked" } as never);
      if (mode === "missing-membership")
        vi.mocked(input.identity.getActiveMembershipForUserAccount).mockResolvedValue(null);
      const response = await post(input);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "not-ready" });
      noWrites(input);
    },
  );

  it("counts both dimensions on the fourth alias call and performs no refusal writes", async () => {
    const input = services();
    for (let index = 0; index < 3; index++) expect((await post(input)).status).toBe(200);
    vi.mocked(input.db.query).mockClear();
    vi.mocked(input.auth.issueOpaqueToken).mockClear();
    const response = await post(input);
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const dimensions = limiters.filter((limiter) => limiter.surface.startsWith("auth.staging-persona-sign-in."));
    expect(dimensions.map((limiter) => limiter.surface).sort()).toEqual([
      "auth.staging-persona-sign-in.alias",
      "auth.staging-persona-sign-in.ip",
    ]);
    for (const limiter of dimensions) {
      expect(limiter.check).toHaveBeenCalledTimes(4);
      expect(limiter.check.mock.results.at(-1)?.value).toMatchObject({ count: 4 });
    }
    noWrites(input);
  });

  it("consumes the server-issued link once through the unchanged consume route and returns 401 the second time", async () => {
    const input = services();
    let stored: Record<string, unknown> | null = null;
    vi.mocked(input.db.query).mockImplementation(async (sql, params) => {
      if (sql.includes("INSERT INTO identity_magic_link_tokens"))
        stored = {
          token_id: params![0],
          user_id: params![1],
          email: params![2],
          token_hash: params![3],
          expires_at: params![5],
          consumed_at: null,
        };
      if (sql.includes("SET consumed_at = now()")) {
        const rows = stored && stored.token_hash === params![0] ? [stored] : [];
        stored = null;
        return { rows } as never;
      }
      return { rows: [] } as never;
    });
    const issuance = await post(input);
    expect(issuance.status).toBe(200);
    const { link } = (await issuance.json()) as { link: string };
    const consume = () =>
      appFor(input).request(`${origin}/magic-link/consume`, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ token: new URL(link).searchParams.get("token") }),
      });
    expect((await consume()).status).toBe(200);
    expect((await consume()).status).toBe(401);
  });

  it("does not expose the synthetic bearer, token or link in console/stdout", async () => {
    const output: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        output.push(args.join(" "));
      });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const input = services();
    expect((await post(input)).status).toBe(200);
    expect((await post(input, "not-a-persona")).status).toBe(403);
    for (const marker of [secret, "magic-link-token", `${origin}/sign-in/magic?token=`])
      expect(output.join("\n")).not.toContain(marker);
  });
});
