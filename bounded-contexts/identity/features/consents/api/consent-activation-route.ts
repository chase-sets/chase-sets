import { Hono } from "hono";
import { resolveRecentAuthenticationStatus } from "@chase-sets/auth-context";
import { hasPermission } from "@chase-sets/platform-runtime/auth";
import { EventStreamTooLongError } from "@chase-sets/event-core/complete-stream";
import { ConsentActivationAuthorityError } from "@chase-sets/platform-policy/consent-activation-authority";
import { ConsentActivationDocumentError, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { IdentityApiEnv } from "../../../api";
import { identityConsentPolicyPublications, type ConsentPolicyPublicationCorpus } from "../domain/consent-bundle";
import { identityConsentActiveVersionPolicyFor, isIdentityConsentPolicyKey } from "../domain/terms-of-service-policy";

export const CONSENT_ACTIVATION_RECENT_AUTH_MAX_AGE_MINUTES = 15;

export type ConsentActivationRouteOptions = Readonly<{
  publications?: ConsentPolicyPublicationCorpus;
  now?: () => Date;
}>;

type ActivationInput = Readonly<{ version: string; documentId: string; contentFingerprint: string }>;

function isActivationInput(value: object): value is ActivationInput {
  return (
    Object.keys(value).length === 3 &&
    "version" in value &&
    "documentId" in value &&
    "contentFingerprint" in value &&
    typeof value.version === "string" &&
    /^v[1-9][0-9]*$/.test(value.version) &&
    value.version.length <= 64 &&
    typeof value.documentId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.documentId) &&
    value.documentId.length <= 64 &&
    typeof value.contentFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.contentFingerprint)
  );
}

export function consentActivationRoutes(
  policies: Pick<PolicyRuntime, "activateConsentPolicyVersion" | "consentActivation">,
  options: ConsentActivationRouteOptions = {},
) {
  const app = new Hono<IdentityApiEnv>();
  const publications = options.publications ?? identityConsentPolicyPublications;
  app.use("*", async (c, next) => {
    const { actor, context } = c.var;
    if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    if (
      actor.userId !== context.audit.performedByUserId ||
      actor.accountId !== context.audit.forAccountId ||
      actor.tenantId !== context.tenantId
    ) {
      return c.json({ error: { code: "actor_context_mismatch" } }, 403);
    }
    if (!hasPermission(actor, "platform-policy.manage")) return c.json({ error: { code: "permission_required" } }, 403);
    if (
      !resolveRecentAuthenticationStatus(actor, {
        maxAgeMinutes: CONSENT_ACTIVATION_RECENT_AUTH_MAX_AGE_MINUTES,
        now: options.now?.(),
      }).recentlyAuthenticated
    )
      return c.json({ error: { code: "recent_authentication_required" } }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ConsentActivationDocumentError || error instanceof ConsentActivationAuthorityError) {
      return c.json({ error: { code: error.code } }, 409);
    }
    if (error instanceof EventStreamTooLongError) return c.json({ error: { code: "history_too_long" } }, 409);
    if ("code" in error && error.code === "concurrency_conflict") {
      return c.json({ error: { code: "activation_concurrency_conflict" } }, 409);
    }
    return c.json({ error: { code: "activation_unavailable" } }, 503);
  });
  app.post("/:policyKey/activate", async (c) => {
    const policyKey = c.req.param("policyKey");
    if (!isIdentityConsentPolicyKey(policyKey)) return c.json({ error: { code: "invalid_policy_key" } }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !isActivationInput(body)) {
      return c.json({ error: { code: "invalid_activation_input" } }, 400);
    }
    const publication = publications[policyKey];
    if (publication.policyKey !== policyKey) return c.json({ error: { code: "publication_key_mismatch" } }, 409);
    if (publication.consentActivatable !== true) return c.json({ error: { code: "publication_not_activatable" } }, 409);
    if (publication.version !== body.version) return c.json({ error: { code: "publication_version_mismatch" } }, 409);
    if (publication.contentFingerprint !== body.contentFingerprint)
      return c.json({ error: { code: "publication_fingerprint_mismatch" } }, 409);
    return c.json(
      await policies.activateConsentPolicyVersion(
        identityConsentActiveVersionPolicyFor(policyKey),
        {
          version: body.version,
          documentId: body.documentId,
          actorUserId: c.var.actor!.userId,
        },
        c.var.context,
      ),
    );
  });
  app.post("/:policyKey/deactivate", async (c) => {
    const policyKey = c.req.param("policyKey");
    if (!isIdentityConsentPolicyKey(policyKey)) return c.json({ error: { code: "invalid_policy_key" } }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
      return c.json({ error: { code: "invalid_deactivation_input" } }, 400);
    }
    return c.json(
      await policies.consentActivation.deactivate(
        identityConsentActiveVersionPolicyFor(policyKey),
        {
          actorUserId: c.var.actor!.userId,
        },
        c.var.context,
      ),
    );
  });
  return app;
}
