import { createHash, timingSafeEqual } from "node:crypto";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { createId } from "@chase-sets/primitives/typed-ids";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../sessions/domain/auth-flow";
import { createAuthRateLimitPair } from "./rate-limits";
import { insertMagicLinkToken } from "../../../support/auth-support/store";
import type { AuthServices } from "../../../support/runtime-support/services";
import type { AuthApiApp, AuthApiContext } from "../../../support/api-support/support";

export const STAGING_PERSONA_SIGN_IN_PATH = "/staging-persona-sign-in" as const;
export const STAGING_PERSONA_MAGIC_LINK_PATH = "/sign-in/magic" as const;
export const STAGING_PERSONA_CANONICAL_ORIGIN = linkIntentOrigins["marketplace-web"].staging;
const stagingPersonaHost = new URL(STAGING_PERSONA_CANONICAL_ORIGIN).host;

export type StagingPersonaAlias = "card-vault" | "sealed-stockroom";

type StagingPersona = Readonly<{
  alias: StagingPersonaAlias;
  accountId: string;
  userId: string;
}>;

/** Auth owns this allowlist; the IDs are the Identity-owned representative seed boundary. */
export const STAGING_PERSONAS: readonly StagingPersona[] = [
  {
    alias: "card-vault",
    accountId: "acc_repr_card_vault_account",
    userId: "usr_repr_card_vault_user",
  },
  {
    alias: "sealed-stockroom",
    accountId: "acc_repr_sealed_stockroom_account",
    userId: "usr_repr_sealed_stockroom_user",
  },
] as const;

const stagingPersonaRateLimits = createAuthRateLimitPair({
  identifier: {
    surface: "auth.staging-persona-sign-in.alias",
    rule: { max: 3, windowMs: 10 * 60 * 1000 },
  },
  ip: {
    surface: "auth.staging-persona-sign-in.ip",
    rule: { max: 10, windowMs: 10 * 60 * 1000 },
  },
});

function readBearer(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const bearer = value.slice("Bearer ".length).trim();
  return bearer || null;
}

function matchesVerifier(raw: string, expected: string | undefined) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = createHash("sha256").update(raw, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

function readAlias(value: unknown): StagingPersonaAlias | null {
  return typeof value === "string" && STAGING_PERSONAS.some((persona) => persona.alias === value)
    ? (value as StagingPersonaAlias)
    : null;
}

function findPersona(alias: StagingPersonaAlias) {
  return STAGING_PERSONAS.find((persona) => persona.alias === alias) ?? null;
}

function originRefused(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  // Forwarded headers are deliberately ignored. The request's resolved host,
  // canonical Origin, and Host header must all agree with staging.
  return (
    origin !== STAGING_PERSONA_CANONICAL_ORIGIN ||
    resolvePublicRequestOrigin(request, { trustForwardedHeaders: false }) !== STAGING_PERSONA_CANONICAL_ORIGIN ||
    host !== stagingPersonaHost
  );
}

function noStoreJson(c: AuthApiContext, body: object, status: 200 | 401 | 403 | 409 | 429) {
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

export function registerStagingPersonaSignInRoutes(app: AuthApiApp, services: AuthServices) {
  app.post(STAGING_PERSONA_SIGN_IN_PATH, async (c) => {
    if (originRefused(c.req.raw)) {
      return noStoreJson(c, { error: "origin-refused" }, 403);
    }

    const bearer = readBearer(c.req.raw);
    if (!bearer || !matchesVerifier(bearer, services.stagingPersonaMagicLinkVerifierSha256)) {
      return noStoreJson(c, { error: "secret-refused" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const alias = readAlias(body && typeof body === "object" ? (body as { alias?: unknown }).alias : undefined);
    const persona = alias ? findPersona(alias) : null;
    if (!persona) {
      return noStoreJson(c, { error: "alias-refused" }, 403);
    }

    const user = await services.identity.getUser(persona.userId);
    const membership = await services.identity.getActiveMembershipForUserAccount(persona.userId, persona.accountId);
    if (
      !user ||
      user.status !== "active" ||
      !user.auth_methods.includes("magic-link") ||
      !membership ||
      membership.status !== "active"
    ) {
      return noStoreJson(c, { error: "not-ready" }, 409);
    }

    const rateLimitResponse = stagingPersonaRateLimits.check(c.req.raw, `alias:${persona.alias}`);
    if (rateLimitResponse) {
      rateLimitResponse.headers.set("Cache-Control", "no-store");
      return rateLimitResponse;
    }

    const token = services.auth.issueOpaqueToken("magic");
    const expiresAt = createExpiryTimestamp(Math.min(authSecurityLifetimesOf(services).magicLinkTtlMs, 10 * 60 * 1000));
    const tokenId = createId("cmd");
    await insertMagicLinkToken(services.db, {
      tokenId,
      userId: persona.userId,
      email: user.primary_email ?? "",
      tokenHash: services.auth.hashSecret(token),
      deliveryToken: null,
      expiresAt,
    });

    const link = `${STAGING_PERSONA_CANONICAL_ORIGIN}${STAGING_PERSONA_MAGIC_LINK_PATH}?token=${encodeURIComponent(token)}`;
    c.header("Cache-Control", "no-store");
    return c.json({ alias: persona.alias, link, expiresAt }, 200);
  });
}
