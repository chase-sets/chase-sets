import { describe, expect, it, vi } from "vitest";
import type { IdentityAuthMutationClient } from "../support/request-support/auth-mutation-client";
import type { RegistrationConsentSubmission } from "../features/consents/domain/registration-consent";
import { mintRegistrationConsentResolution } from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";

// The parameter is the enforcement, so the contract is asserted at the type
// level as well as at runtime: `verify:typecheck` is a mandatory gate, and a
// `@ts-expect-error` that stops erroring fails compilation, so these assertions
// cannot rot into no-ops.

function createPersonalIdentityStub() {
  return vi.fn(async () => ({
    userId: "usr_1",
    accountId: "acc_1",
    membershipId: "mbr_1",
    snapshots: [],
  })) as unknown as IdentityAuthMutationClient["createPersonalIdentity"];
}

function submission(): RegistrationConsentSubmission {
  return {
    resolution: mintRegistrationConsentResolution({
      requirements: [],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    }),
    affirmed: false,
  };
}

describe("registration consent submission contract", () => {
  it("rejects a createPersonalIdentity call that omits the submission", async () => {
    const createPersonalIdentity = createPersonalIdentityStub();

    await createPersonalIdentity(
      // @ts-expect-error registrationConsent is required, so omitting it cannot compile.
      {
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        foundersBetaAccessStartedAt: undefined,
      },
    );

    expect(createPersonalIdentity).toHaveBeenCalled();
  });

  it("rejects an explicitly absent submission", async () => {
    const createPersonalIdentity = createPersonalIdentityStub();

    await createPersonalIdentity({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      // @ts-expect-error the parameter is non-nullable, so undefined cannot compile.
      registrationConsent: undefined,
    });

    expect(createPersonalIdentity).toHaveBeenCalled();
  });

  it("no longer accepts the deleted loose consents input", async () => {
    const createPersonalIdentity = createPersonalIdentityStub();

    await createPersonalIdentity({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      registrationConsent: submission(),
      // @ts-expect-error the loose optional consents input was deleted, not deprecated.
      consents: [{ policyKey: "terms-of-service", policyVersion: "v1" }],
    });

    expect(createPersonalIdentity).toHaveBeenCalled();
  });

  it("treats an aliased submission contract as the same required parameter", async () => {
    // Evasion C from the parked review: aliasing the contract type. An alias of
    // a required parameter is still that required parameter -- there is no
    // activation flag behind the type for an alias to switch off -- so this
    // compiles and works, which is precisely the point: the evasion has no
    // target.
    type AliasedRegistrationConsentSubmission = RegistrationConsentSubmission;

    const aliased: AliasedRegistrationConsentSubmission = submission();
    const createPersonalIdentity = createPersonalIdentityStub();

    const identity = await createPersonalIdentity({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      registrationConsent: aliased,
    });

    expect(identity.userId).toBe("usr_1");
    expect(createPersonalIdentity).toHaveBeenCalledWith(expect.objectContaining({ registrationConsent: aliased }));
  });
});
