import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import {
  identityConsentPolicyPublications,
  isConsentActivatablePublication,
  resolveConsentPolicyMemberWithGuard,
} from "../domain/consent-bundle";
import {
  assertConsentRecordAuthorization,
  authorizeConsentForActor,
  ConsentRecordingAuthorizationError,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import type { RecordConsentCommand } from "../domain/domain";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { evaluateConsentPolicyAcceptance } from "../read-model/consent-bundle-acceptance";
import { findCurrentConsent } from "../read-model/queries";
import { resolveTermsAcceptanceStatus } from "../read-model/terms-acceptance";
import type { ConsentServices } from "./runtime";

/**
 * Two passes: the first can lose a race against an activation that moved
 * between the resolution and the append, the second runs against the moved
 * authority. A third pass would only widen the window in which a caller is held
 * while somebody else keeps re-activating.
 */
const TERMS_CONSENT_APPEND_ATTEMPTS = 2;

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: t("identity.features.consents.api.termsRoute.authentication.required"),
    },
  };
}

function termsOfServiceNotActive() {
  return {
    error: {
      code: "terms_of_service_not_active",
      message: t("identity.features.consents.api.termsRoute.no.active.version"),
    },
  };
}

function isEventStoreConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

/**
 * The command shape for one Terms acceptance.
 *
 * `policyVersion` is a parameter because authorization and versioning are
 * separate questions asked at different moments: who may record for whom is
 * decided before any authority is read, and the exact version is decided by the
 * resolution that also mints the guard. The pre-read call therefore passes the
 * empty version deliberately -- no authorization rule reads it, and the real
 * command is rebuilt with the resolved version before anything is appended.
 */
function termsAcceptanceCommand(
  subject: Readonly<{ userId: string; accountId: string }>,
  consentId: ConsentId,
  policyVersion: string,
): RecordConsentCommand {
  return {
    type: "RecordConsent",
    consentId,
    subjectType: "user",
    userId: subject.userId as UserId,
    accountId: subject.accountId as AccountId,
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    policyVersion,
    recordedAt: new Date().toISOString(),
  } as const;
}

export type TermsRouteDeps = Readonly<{
  db: PgQueryable;
  // The Consent Activation Authority surface, not the whole policy runtime and
  // deliberately not `resolvePolicy`: the acceptance gate's required version
  // comes from one validated authority read, so the cached policy-document
  // value is structurally unreachable from this route.
  policies: Pick<PolicyRuntime, "consentActivation">;
  // Held as a reference to the whole `consents` service, not a
  // pre-dereferenced member, so mounting this route never touches the append
  // path before a request actually needs it -- mirrors how
  // `consentRoutes(services.consents)` is wired in `./route.ts`.
  consents: Pick<ConsentServices, "recordGuardedConsent">;
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

    const subject = { userId: actor.userId, accountId: actor.accountId };

    let authorization: ConsentRecordingAuthorization;
    try {
      authorization = authorizeConsentForActor(context);
      // Authorization precedence is unchanged, and it now precedes the
      // authority read as well: an unauthorized subject -- a shared platform
      // principal, a foreign user, a context mismatch -- is rejected with its
      // own named code before this request observes any activation state at
      // all. Nothing here reads the version, so deciding it before one is
      // resolved is not merely safe, it is the whole point.
      assertConsentRecordAuthorization(termsAcceptanceCommand(subject, createId("cns"), ""), authorization);
    } catch (error) {
      if (error instanceof ConsentRecordingAuthorizationError) {
        return c.json({ error: { code: error.code, message: error.message } }, 403);
      }
      throw error;
    }

    // Publication eligibility is the second thing that precedes any authority
    // read. A document Public Presence has not compiled as consent-activatable
    // has no activation question to ask, so asking one would put an inert
    // policy into the read trace an operator inspects.
    if (!isConsentActivatablePublication(identityConsentPolicyPublications[TERMS_OF_SERVICE_CONSENT_POLICY_KEY])) {
      return c.json(termsOfServiceNotActive(), 409);
    }

    for (let attempt = 1; ; attempt += 1) {
      // One read supplies the required version AND the guard this append
      // commits against. Resolving the version here and guarding against a
      // revision observed anywhere else is the resolve/append race itself.
      const member = await resolveConsentPolicyMemberWithGuard(
        deps.policies.consentActivation,
        TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
      );
      const current = await findCurrentConsent(deps.db, {
        userId: subject.userId,
        accountId: subject.accountId,
        policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
      });
      const status = evaluateConsentPolicyAcceptance(TERMS_OF_SERVICE_CONSENT_POLICY_KEY, member.outcome, current);

      // Replays and retries of an already-current acceptance are a no-op --
      // the read model is checked before recording so double-clicks and
      // request retries never produce a second consent fact for the same
      // (subject, policy key, version).
      if (status.accepted) {
        return c.json(status, 200);
      }

      // Fail closed rather than record an unversioned agreement. A member is
      // required exactly when a validated authority says the key is activated
      // at its published version, and a Consent recorded against anything else
      // is a permanent, unauditable fact.
      if (member.outcome.kind !== "required") {
        return c.json(termsOfServiceNotActive(), 409);
      }

      const consentId = createId("cns");
      try {
        await deps.consents.recordGuardedConsent({
          streamId: `identity.consent-${consentId}`,
          command: termsAcceptanceCommand(subject, consentId, member.outcome.requirement.version),
          context,
          authorization,
          // A guard is retained for every authority actually read, so this
          // carries the one read above and nothing else. The append is
          // all-or-nothing: if the authority moved, the Consent is not written.
          activationGuards: member.guard ? [member.guard.guard] : [],
        });
      } catch (error) {
        if (error instanceof ConsentRecordingAuthorizationError) {
          return c.json({ error: { code: error.code, message: error.message } }, 403);
        }
        // A moved authority is a conflict on the guard, not on the Consent.
        // The next pass re-resolves and records against the version that is
        // active now; exhausting the passes leaves the existing 409 `conflict`
        // to the mounted platform error handler rather than inventing a code.
        if (attempt < TERMS_CONSENT_APPEND_ATTEMPTS && isEventStoreConcurrencyConflict(error)) {
          continue;
        }
        throw error;
      }

      const after = await resolveTermsAcceptanceStatus(deps.db, deps.policies.consentActivation, {
        userId: subject.userId,
        accountId: subject.accountId,
      });
      return c.json(after, 201);
    }
  });

  return app;
}
