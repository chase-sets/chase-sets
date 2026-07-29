import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { consentActivationAuthorityReaderForTest } from "../domain/consent-bundle-test-support";
import { resolveTermsAcceptanceStatus } from "./terms-acceptance";

/**
 * The SHIPPED corpus, deliberately unmocked.
 *
 * Nothing in it is consent-activatable at this head, so no version of Terms of
 * Service is currently acceptable -- no matter what an activation authority
 * says. This is the publication-ineligible arm of the acceptance gate, and it is
 * the arm a mocked corpus can never exercise, which is why it lives in its own
 * file.
 */

const ACTIVATION_KEY = "identity.terms-of-service-active-version";

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as PgQueryable;
}

describe("Terms of Service acceptance against the shipped publication corpus", () => {
  it("requires no version and accepts nobody, even with an active authority", async () => {
    const read = vi.fn(consentActivationAuthorityReaderForTest({ [ACTIVATION_KEY]: "v1" }));

    const status = await resolveTermsAcceptanceStatus(
      fakeDb([
        {
          consent_id: "cns_1",
          subject_type: "user",
          user_id: "usr_1",
          account_id: "acc_1",
          policy_key: "terms-of-service",
          policy_version: "v1",
          status: "recorded",
          recorded_at: "2026-03-01T00:00:00.000Z",
          withdrawn_at: null,
          updated_at: "2026-03-01T00:00:00.000Z",
        },
      ]),
      read,
      { userId: "usr_1", accountId: "acc_1" },
    );

    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: "v1",
      acceptedAt: "2026-03-01T00:00:00.000Z",
    });
    // A publication-ineligible member costs no authority read: there is nothing
    // to activate, so there is nothing to ask about.
    expect(read).not.toHaveBeenCalled();
  });
});
