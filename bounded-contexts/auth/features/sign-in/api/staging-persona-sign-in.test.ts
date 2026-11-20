import {
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createHash, timingSafeEqual } from "node:crypto";
import { representativePersonaIds } from "@chase-sets/catalog-seed/ids";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV, resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../../../support/runtime-support/services";
import { createAuthServices, startInteractiveAuth } from "../../../support/runtime-support/services";
import contextManifest from "../../../context.json" with { type: "json" };
import type { AuthApiEnv } from "../../../support/api-support/support";
import { buildAuthApi } from "../../../api";
import { loader as adminMagicLinkLoader } from "../../../routes/access-admin/sign-in-magic";
import type { LoaderFunctionArgs } from "react-router";

const secret = "cs_stg_persona_synthetic_secret";
const verifier = createHash("sha256").update(secret).digest("hex");
const origin = "https://marketplace.staging.chasesets.com";
const adminOrigin = "https://admin.staging.chasesets.com";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  for (const limiter of limiters) {
    limiter.clear();
    limiter.check.mockClear();
  }
  vi.mocked(timingSafeEqual).mockClear();
  vi.mocked(startInteractiveAuth).mockClear();
});

function post(
  input: AuthServices,
  alias = "card-vault",
  headers: Record<string, string> = requestHeaders(),
  url = origin,
  destination?: unknown,
) {
  return appFor(input).request(`${url}/staging-persona-sign-in`, {
    method: "POST",
    headers,
    body: JSON.stringify({ alias, destination }),
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

  it.each(["card-vault", "sealed-stockroom"] as const)("issues an admin-host link for %s", async (alias) => {
    const input = services();
    const response = await post(input, alias, requestHeaders(), origin, "admin");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { alias: string; link: string; expiresAt: string };
    expect(body.alias).toBe(alias);
    expect(new URL(body.link).origin).toBe(adminOrigin);
    expect(new URL(body.link).pathname).toBe("/access/sign-in/magic");
    expect(new URL(body.link).searchParams.get("token")).toBe("magic-link-token");
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(input.identity.getUser).toHaveBeenCalledWith(representativePersonaIds[alias].userId);
    expect(input.identity.getActiveMembershipForUserAccount).toHaveBeenCalledWith(
      representativePersonaIds[alias].userId,
      representativePersonaIds[alias].accountId,
    );
  });

  it("keeps explicit marketplace issuance identical to the omitted destination", async () => {
    const response = await post(services(), "card-vault", requestHeaders(), origin, "marketplace");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alias: "card-vault",
      link: `${origin}/sign-in/magic?token=magic-link-token`,
    });
  });

  it.each(["unknown", "https://evil.example", "Admin", "", null, 1, {}, ["admin"]].map((destination) => [destination]))(
    "refuses destination %j before identity reads or writes",
    async (destination) => {
      const input = services();
      const response = await post(input, "card-vault", requestHeaders(), origin, destination);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "destination-refused" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(input.identity.getUser).not.toHaveBeenCalled();
      noWrites(input);
    },
  );

  it("keeps the issuer's marketplace Origin/Host and bearer guards for admin links", async () => {
    const input = services();
    expect((await post(input, "card-vault", requestHeaders(secret, adminOrigin), adminOrigin, "admin")).status).toBe(
      403,
    );
    expect((await post(input, "card-vault", requestHeaders("wrong-bearer"), origin, "admin")).status).toBe(401);
    expect((await post(input, "not-a-persona", requestHeaders(), origin, "admin")).status).toBe(403);
    noWrites(input);
  });

  it("shares the alias rate limit across destinations", async () => {
    const input = services();
    for (const destination of [undefined, "admin", "marketplace"])
      expect((await post(input, "card-vault", requestHeaders(), origin, destination)).status).toBe(200);
    vi.mocked(input.db.query).mockClear();
    vi.mocked(input.auth.issueOpaqueToken).mockClear();
    expect((await post(input, "card-vault", requestHeaders(), origin, "admin")).status).toBe(429);
    noWrites(input);
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
      // The projection readers return `rows[0] ?? null`, which the row type cannot express as nullable.
      if (mode === "missing-user") vi.mocked(input.identity.getUser).mockResolvedValue(null as never);
      if (mode === "inactive-user" || mode === "non-magic-user")
        vi.mocked(input.identity.getUser).mockResolvedValue({
          status: mode === "inactive-user" ? "suspended" : "active",
          auth_methods: mode === "non-magic-user" ? ["password"] : ["magic-link"],
        } as never);
      if (mode === "inactive-membership")
        vi.mocked(input.identity.getActiveMembershipForUserAccount).mockResolvedValue({ status: "revoked" } as never);
      if (mode === "missing-membership")
        vi.mocked(input.identity.getActiveMembershipForUserAccount).mockResolvedValue(null as never);
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

  it.each([undefined, "admin"])(
    "consumes the server-issued %s link once through the existing host flow",
    async (destination) => {
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
      const issuance = await post(input, "card-vault", requestHeaders(), origin, destination);
      expect(issuance.status).toBe(200);
      const { link } = (await issuance.json()) as { link: string };
      const consume = () =>
        appFor(input).request(`${new URL(link).origin}/magic-link/consume`, {
          method: "POST",
          headers: requestHeaders(),
          body: JSON.stringify({ token: new URL(link).searchParams.get("token") }),
        });
      if (destination === "admin") {
        vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "http://platform-api.internal:8080");
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof globalThis.fetch>(async (_url, init) => {
            expect(new Request(_url, init).url).toBe("http://platform-api.internal:8080/api/auth/magic-link/consume");
            expect(JSON.parse(String(init?.body))).toEqual({ token: new URL(link).searchParams.get("token") });
            return consume();
          }),
        );
        const response = await adminMagicLinkLoader({
          request: new Request(link),
          params: {},
          context: {},
        } as LoaderFunctionArgs);
        expect(response).toBeInstanceOf(Response);
        const landing = response as Response;
        expect(landing.status).toBe(302);
        expect(landing.headers.get("Location")).toBe("/");
        const cookies = landing.headers.getSetCookie().join(";");
        expect(cookies).toContain("chase_sets_session=synthetic-session-token");
        expect(cookies).toContain("Secure");
        expect(cookies).not.toMatch(/domain=/i);
      } else {
        expect((await consume()).status).toBe(200);
      }
      expect(startInteractiveAuth).toHaveBeenCalledWith(
        input,
        expect.objectContaining({
          userId: "usr_repr_card_vault_user",
          authenticationMethod: "magic-link",
        }),
      );
      expect((await consume()).status).toBe(401);
    },
  );

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
