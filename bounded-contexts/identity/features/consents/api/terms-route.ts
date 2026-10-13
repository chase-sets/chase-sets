import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ConsentActivationAuthorityReader } from "../domain/consent-bundle";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import {
  authorizeConsentForActor,
  ConsentRecordingAuthorizationError,
} from "../domain/consent-recording-authorization";
import { resolveTermsAcceptanceStatus } from "../read-model/terms-acceptance";
import { assertTermsConsentAuthorization, type ConsentServices } from "./runtime";

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: t("identity.features.consents.api.termsRoute.authentication.required"),
    },
  };
}

export type TermsRouteDeps = Readonly<{
  db: PgQueryable;
  publication?: Parameters<typeof resolveTermsAcceptanceStatus>[3];
  // The Consent Activation Authority surface, not the whole policy runtime and
  // deliberately not `resolvePolicy`: the acceptance gate's required version
  // comes from one validated authority read, so the cached policy-document
  // value is structurally unreachable from this route.
  policies: Readonly<{ consentActivation: ConsentActivationAuthorityReader }>;
  consents: Pick<ConsentServices, "recordTermsConsent">;
}>;

/**
 * The authenticated Terms of Service acceptance surface: `GET /` reports
 * whether the current actor has accepted the active required version (for
 * routing an actor missing acceptance to a policy-review step and for
 * account consent-history display), and `POST /accept` records acceptance
 * of the active version for the current actor. Both always resolve the
 * active version server-side; the client never supplies a version or guard.
 * Read-side status honors the publication override; recording always uses the
 * compiled publication and fails closed if that override diverges.
 */
export function termsOfServiceConsentRoutes(deps: TermsRouteDeps) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }

    const status = await resolveTermsAcceptanceStatus(
      deps.db,
      deps.policies.consentActivation,
      {
        userId: actor.userId,
        accountId: actor.accountId,
      },
      deps.publication,
    );
    return c.json(status);
  });

  app.post("/accept", async (c) => {
    const actor = c.var.actor;
    const context = c.var.context;
    if (!actor || !context) {
      return c.json(authenticationRequired(), 401);
    }

    const consentId = createId("cns");
    try {
      const authorization = authorizeConsentForActor(context);
      const input = {
        streamId: `identity.consent-${consentId}`,
        consentId,
        subjectType: "user" as const,
        userId: actor.userId as UserId,
        accountId: actor.accountId as AccountId,
        recordedAt: new Date().toISOString(),
        context,
        authorization,
        activationAuthority: deps.policies.consentActivation,
      };
      assertTermsConsentAuthorization(input);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await resolveTermsAcceptanceStatus(
          deps.db,
          deps.policies.consentActivation,
          actor,
          deps.publication,
        );
        if (before.accepted) return c.json(before, 200);
        if (before.requiredVersion.length === 0) {
          return c.json(
            {
              error: {
                code: "terms_of_service_not_active",
                message: t("identity.features.consents.api.termsRoute.no.active.version"),
              },
            },
            409,
          );
        }
        try {
          await deps.consents.recordTermsConsent(input);
          const after = await resolveTermsAcceptanceStatus(
            deps.db,
            deps.policies.consentActivation,
            actor,
            deps.publication,
          );
          return c.json(after, 201);
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict") {
            if (attempt === 1) throw error;
            continue;
          }
          if (error instanceof IdentityDomainError) {
            return c.json(
              {
                error: {
                  code: "terms_of_service_not_active",
                  message: t("identity.features.consents.api.termsRoute.no.active.version"),
                },
              },
              409,
            );
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ConsentRecordingAuthorizationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 403);
      }
      throw error;
    }
  });

  return app;
}
