import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import {
  assertConsentRecordAuthorization,
  authorizeConsentForActor,
  ConsentRecordingAuthorizationError,
} from "../domain/consent-recording-authorization";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { resolveTermsAcceptanceStatus } from "../read-model/terms-acceptance";
import type { ConsentServices } from "./runtime";

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
  // The Consent Activation Authority surface, not the whole policy runtime and
  // deliberately not `resolvePolicy`: the acceptance gate's required version
  // comes from one validated authority read, so the cached policy-document
  // value is structurally unreachable from this route.
  policies: Pick<PolicyRuntime, "consentActivation">;
  // Held as a reference to the whole `consents` service, not a
  // pre-dereferenced `commandHandler`, so mounting this route never touches
  // `.commandHandler` before a request actually needs it -- mirrors how
  // `consentRoutes(services.consents)` is wired in `./route.ts`.
  consents: Pick<ConsentServices, "commandHandler">;
}>;

/**
 * The authenticated Terms of Service acceptance surface: `GET /` reports
 * whether the current actor has accepted the active required version (for
 * routing an actor missing acceptance to a policy-review step and for
 * account consent-history display), and `POST /accept` records acceptance
 * of the active version for the current actor. Both always resolve the
 * active version server-side -- the client never supplies a version -- so
 * acceptance can never be recorded against a version the actor was not
 * actually shown.
 */
export function termsOfServiceConsentRoutes(deps: TermsRouteDeps) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }

    const status = await resolveTermsAcceptanceStatus(deps.db, deps.policies.consentActivation, {
      userId: actor.userId,
      accountId: actor.accountId,
    });
    return c.json(status);
  });

  app.post("/accept", async (c) => {
    const actor = c.var.actor;
    const context = c.var.context;
    if (!actor || !context) {
      return c.json(authenticationRequired(), 401);
    }

    const before = await resolveTermsAcceptanceStatus(deps.db, deps.policies.consentActivation, {
      userId: actor.userId,
      accountId: actor.accountId,
    });
    // Replays and retries of an already-current acceptance are a no-op --
    // the read model is checked before recording so double-clicks and
    // request retries never produce a second consent fact for the same
    // (subject, policy key, version).
    if (before.accepted) {
      return c.json(before, 200);
    }

    const consentId = createId("cns");
    const command = {
      type: "RecordConsent",
      consentId,
      subjectType: "user",
      userId: actor.userId as UserId,
      accountId: actor.accountId as AccountId,
      policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
      policyVersion: before.requiredVersion,
      recordedAt: new Date().toISOString(),
    } as const;

    try {
      const authorization = authorizeConsentForActor(context);
      // Authorization precedence is unchanged: an unauthorized subject -- a
      // shared platform principal, a foreign user, a context mismatch -- is
      // still rejected with its own named code, decided by the same domain
      // assertion the command handler applies, before any other precondition
      // is considered.
      assertConsentRecordAuthorization(command, authorization);

      // Then fail closed rather than record an unversioned agreement. The
      // required version is empty exactly when no validated authority says the
      // key is activated at its published version, and a Consent recorded
      // against an empty version is a permanent, unauditable fact. This arm
      // only ever refuses a recording; it never admits one that the
      // authorization rules would have refused.
      if (command.policyVersion.length === 0) {
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

      await deps.consents.commandHandler({
        streamId: `identity.consent-${consentId}`,
        command,
        context,
        authorization,
      });
    } catch (error) {
      if (error instanceof ConsentRecordingAuthorizationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 403);
      }
      throw error;
    }

    const after = await resolveTermsAcceptanceStatus(deps.db, deps.policies.consentActivation, {
      userId: actor.userId,
      accountId: actor.accountId,
    });
    return c.json(after, 201);
  });

  return app;
}
