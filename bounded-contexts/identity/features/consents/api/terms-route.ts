import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import {
  authorizeConsentForActor,
  ConsentRecordingAuthorizationError,
} from "../domain/consent-recording-authorization";
import { ConsentBundleAdmissionError } from "../domain/consent-bundle-admission";
import type { ConsentActivationAuthorityReader } from "../domain/consent-bundle";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { isConsentVersionRequired } from "../read-model/consent-acceptance";
import { resolveTermsAcceptanceStatus } from "../read-model/terms-acceptance";
import { ConsentActivationAdmissionError } from "./consent-recording-admission";
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
  /**
   * The Consent Activation Authority read. The required version, the activation
   * state, and the guard revision all come from this one source -- the route no
   * longer holds a `PolicyRuntime`, so there is no cached policy value adjacent
   * to this surface for a future edit to reach for.
   */
  readAuthority: ConsentActivationAuthorityReader;
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

    const status = await resolveTermsAcceptanceStatus(deps.db, deps.readAuthority, {
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

    const before = await resolveTermsAcceptanceStatus(deps.db, deps.readAuthority, {
      userId: actor.userId,
      accountId: actor.accountId,
    });
    // Replays and retries of an already-current acceptance are a no-op --
    // the read model is checked before recording so double-clicks and
    // request retries never produce a second consent fact for the same
    // (subject, policy key, version). `before.accepted` is now decided against
    // the ACTIVE version from the authority, so a subject holding a superseded
    // version falls through to the handler instead of short-circuiting here.
    if (before.accepted) {
      return c.json(before, 200);
    }

    // Nothing is currently required, so there is no version to record. Refused
    // here rather than handed to the command as an empty version: the same 409
    // the admission would produce, with the reason that is actually true.
    if (!isConsentVersionRequired(before)) {
      return c.json(
        {
          error: {
            code: "consent_policy_not_activated",
            message: `No version of '${TERMS_OF_SERVICE_CONSENT_POLICY_KEY}' is currently activated for acceptance.`,
          },
        },
        409,
      );
    }

    const consentId = createId("cns");
    try {
      await deps.consents.commandHandler({
        streamId: `identity.consent-${consentId}`,
        command: {
          type: "RecordConsent",
          consentId,
          subjectType: "user",
          userId: actor.userId as UserId,
          accountId: actor.accountId as AccountId,
          policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
          policyVersion: before.requiredVersion,
          recordedAt: new Date().toISOString(),
        },
        context,
        authorization: authorizeConsentForActor(context),
      });
    } catch (error) {
      if (error instanceof ConsentRecordingAuthorizationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 403);
      }
      // The publication and activation halves of the recording admission. A
      // version that is not both published and activated is a state of the
      // platform, not of this request, so it is 409 rather than 403: the actor
      // did nothing wrong and nothing was written.
      if (error instanceof ConsentBundleAdmissionError || error instanceof ConsentActivationAdmissionError) {
        return c.json({ error: { code: error.code, message: error.message } }, 409);
      }
      throw error;
    }

    const after = await resolveTermsAcceptanceStatus(deps.db, deps.readAuthority, {
      userId: actor.userId,
      accountId: actor.accountId,
    });
    return c.json(after, 201);
  });

  return app;
}
