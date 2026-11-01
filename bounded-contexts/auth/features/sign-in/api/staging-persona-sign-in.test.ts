import {
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../../../support/runtime-support/services";
import type { AuthApiEnv } from "../../../support/api-support/support";
import { buildAuthApi } from "../../../api";

const secret = "cs_stg_persona_synthetic_secret";
const verifier = createHash("sha256").update(secret).digest("hex");
const origin = "https://marketplace.staging.chasesets.com";

function services(overrides: Partial<AuthServices> = {}) {
  const insert = vi.fn(async () => undefined);
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
    ...overrides,
    __insert: insert,
  } as unknown as AuthServices & { __insert: typeof insert };
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

describe("staging persona sign-in", () => {
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
    expect(input.auth.issueOpaqueToken).toHaveBeenCalledWith("magic");
  });
});
