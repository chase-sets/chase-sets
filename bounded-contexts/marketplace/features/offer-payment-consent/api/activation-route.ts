import { Hono } from "hono";
import { resolveRecentAuthenticationStatus } from "@chase-sets/auth-context";
import { EventStreamTooLongError } from "@chase-sets/event-core/complete-stream";
import { ConsentActivationAuthorityError } from "@chase-sets/platform-policy/consent-activation-authority";
import { ConsentActivationDocumentError, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { hasPermission } from "@chase-sets/platform-runtime/auth";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type { MarketplaceApiEnv } from "../../../api";
import {
  isOfferPaymentConsentVersion,
  OFFER_PAYMENT_CONSENT_POLICY_KEY,
  offerPaymentConsentPublications,
  type OfferPaymentConsentPublications,
} from "../domain/consent-text";
import { offerPaymentConsentActivationPolicy } from "../domain/policy";

type ActivationInput = Readonly<{ documentId: string; version: string; contentFingerprint: string }>;

function isActivationInput(value: unknown): value is ActivationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    "version" in value &&
    isOfferPaymentConsentVersion(value.version) &&
    "documentId" in value &&
    typeof value.documentId === "string" &&
    value.documentId.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.documentId) &&
    "contentFingerprint" in value &&
    typeof value.contentFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.contentFingerprint)
  );
}

export type OfferPaymentConsentActivationRouteOptions = Readonly<{
  deploymentEnvironment?: DeploymentEnvironment;
  publications?: OfferPaymentConsentPublications;
  now?: () => Date;
}>;

export function createOfferPaymentConsentActivationRoutes(
  policies: Pick<PolicyRuntime, "activateConsentPolicyVersion">,
  options: OfferPaymentConsentActivationRouteOptions = {},
) {
  const app = new Hono<MarketplaceApiEnv>();
  const publications = options.publications ?? offerPaymentConsentPublications;
  const activationPolicy = offerPaymentConsentActivationPolicy(publications);
  const allowsPending = options.deploymentEnvironment === "test" || options.deploymentEnvironment === "staging";

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
  app.post("/policies/offer-payment-consent/activate", async (c) => {
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
    if (!resolveRecentAuthenticationStatus(actor, { maxAgeMinutes: 15, now: options.now?.() }).recentlyAuthenticated) {
      return c.json({ error: { code: "recent_authentication_required" } }, 403);
    }

    const body: unknown = await c.req.json().catch(() => null);
    if (!isActivationInput(body)) return c.json({ error: { code: "invalid_activation_input" } }, 400);
    const publication = publications[body.version];
    if (!publication) return c.json({ error: { code: "publication_version_mismatch" } }, 409);
    if (publication.policyKey !== OFFER_PAYMENT_CONSENT_POLICY_KEY) {
      return c.json({ error: { code: "publication_key_mismatch" } }, 409);
    }
    if (!allowsPending && (publication.consentActivatable !== true || !publication.counselApprovalReference)) {
      return c.json({ error: { code: "publication_not_activatable" } }, 409);
    }
    if (publication.version !== body.version) return c.json({ error: { code: "publication_version_mismatch" } }, 409);
    if (publication.contentFingerprint !== body.contentFingerprint) {
      return c.json({ error: { code: "publication_fingerprint_mismatch" } }, 409);
    }
    return c.json(
      await policies.activateConsentPolicyVersion(
        activationPolicy,
        { version: body.version, documentId: body.documentId, actorUserId: actor.userId, advanceOnly: true },
        context,
      ),
    );
  });
  return app;
}
