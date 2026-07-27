import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isConsentBundleMemberPolicyKey } from "../../features/consents/domain/consent-bundle";
import { identityConsentActiveVersionPolicies } from "../../features/consents/domain/terms-of-service-policy";
import type { IdentityServices } from "./services";

/**
 * The provisioning-side counterpart to the Consent recording admission.
 *
 * Recording a Consent for a Consent Bundle member requires that member's
 * Consent Activation Authority to report the exact version active. Seeded,
 * bootstrapped and fixture-provisioned identities are no exception -- there is
 * deliberately no bypass, no "seed mode" flag, and no second command that
 * writes an unadmitted Consent. What a provisioning path may do instead is what
 * an operator would do: publish the value as a policy document and activate the
 * key, explicitly, before recording anything against it.
 *
 * This is idempotent and is a no-op once the key is already active at
 * `version`, so re-running a seed neither re-activates nor fails.
 *
 * Scope: this activates a key in whatever database the caller is seeding. It is
 * not, and must not become, the path by which a policy goes live for real
 * people -- that is an operator action against a live environment, owned by a
 * deploy issue, and nothing here runs there.
 */
export async function ensureSeededConsentActivation(
  services: IdentityServices,
  context: EventStoreContext,
  params: Readonly<{ policyKey: string; version: string; actorUserId: string; activatedAt: string }>,
): Promise<void> {
  if (!isConsentBundleMemberPolicyKey(params.policyKey)) {
    return;
  }

  const definition = identityConsentActiveVersionPolicies[params.policyKey];
  const current = await services.policies.consentActivation.read(definition.policyKey);
  if (current.status === "active" && current.activeVersion === params.version) {
    return;
  }

  await services.policies.consentActivation.register(definition, context);

  // The document is the value; the authority is the activation. A re-run that
  // already published the value reuses that document rather than authoring a
  // second one that would overlap its effective window.
  const resolved = await services.policies.resolvePolicy(definition);
  const documentId =
    resolved.documentId !== null && resolved.value.version === params.version
      ? resolved.documentId
      : (
          await services.policies.createPolicyDocument(
            definition,
            {
              value: { version: params.version },
              status: "active",
              effectiveFrom: params.activatedAt,
              effectiveUntil: null,
              actorUserId: params.actorUserId,
            },
            context,
          )
        ).documentId;

  await services.policies.consentActivation.activate(
    definition,
    {
      version: params.version,
      documentId,
      actorUserId: params.actorUserId,
      activatedAt: params.activatedAt,
    },
    context,
  );
}
