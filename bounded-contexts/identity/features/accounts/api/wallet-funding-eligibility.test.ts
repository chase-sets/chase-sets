import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { activeSnapshot, registeredNeverActivatedSnapshot } from "../../../tests/consent-activation-authority-fixtures";
import { identityConsentActiveVersionPolicies } from "../../consents/domain/terms-of-service-policy";
import { createIdentityWalletFundingEligibilityResolver } from "./wallet-funding-eligibility";

vi.mock("@chase-sets/platform-policy/consent-activation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-policy/consent-activation-authority")>()),
  readConsentActivationAuthority: vi.fn(),
}));

// Synthetic publication makes the future accepted branch reachable without
// changing the shipped, counsel-gated Payments Terms publication.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/public-docs")>();
  return {
    ...actual,
    publicPolicyPublicationRecords: {
      ...actual.publicPolicyPublicationRecords,
      "payments-terms": {
        ...actual.publicPolicyPublicationRecords["payments-terms"],
        version: "v999",
        contentFingerprint: "sha256:synthetic-wallet-funding-fixture",
        publicationStatus: "published",
        consentActivatable: true,
      },
    },
  };
});

const accountId = "acc_synthetic" as AccountId;
const authorityKey = identityConsentActiveVersionPolicies["payments-terms"].policyKey;

function fakePool(status: "active" | "suspended" | null, accepted: boolean) {
  const accountRows =
    status === null
      ? []
      : [
          {
            account_id: accountId,
            name: "synthetic",
            display_name: "Synthetic account",
            account_type: "individual",
            status,
            badges: [],
            founder_number: null,
            founders_window_started_at: null,
            founders_window_ends_at: null,
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ];
  const consentRows = accepted
    ? [
        {
          consent_id: "cns_synthetic",
          subject_type: "account",
          subject_id: accountId,
          user_id: null,
          account_id: accountId,
          policy_key: "payments-terms",
          policy_version: "v999",
          status: "recorded",
          recorded_at: "2026-07-01T00:00:00.000Z",
          withdrawn_at: null,
          updated_at: "2026-07-01T00:00:00.000Z",
        },
      ]
    : [];
  const query = vi
    .fn()
    .mockRejectedValue(new Error("Unexpected database read"))
    .mockResolvedValueOnce({ rows: accountRows, rowCount: accountRows.length })
    .mockResolvedValueOnce({ rows: consentRows, rowCount: consentRows.length });
  const pool: PgTransactionalPool = {
    query,
    connect: async () => {
      throw new Error("Unexpected transaction");
    },
  };
  return pool;
}

describe("createIdentityWalletFundingEligibilityResolver", () => {
  beforeEach(() => vi.mocked(readConsentActivationAuthority).mockReset());

  describe.each(["active", "suspended", null] as const)("account status %s", (status) => {
    it.each([
      { paymentsTerms: "not-active", active: false, accepted: false },
      { paymentsTerms: "accepted", active: true, accepted: true },
      { paymentsTerms: "unaccepted", active: true, accepted: false },
    ] as const)("resolves $paymentsTerms from authority and acceptance reads", async (state) => {
      vi.mocked(readConsentActivationAuthority).mockResolvedValue(
        state.active ? activeSnapshot(authorityKey, "v999") : registeredNeverActivatedSnapshot(authorityKey),
      );
      const pool = fakePool(status, state.accepted);
      const resolver = createIdentityWalletFundingEligibilityResolver(pool);

      expect(await resolver.resolve(accountId)).toEqual({
        goodStanding: status === "active",
        paymentsTerms: state.paymentsTerms,
      });
      expect(readConsentActivationAuthority).toHaveBeenCalledTimes(1);
      expect(readConsentActivationAuthority).toHaveBeenCalledWith(expect.anything(), authorityKey);
      expect(pool.query).toHaveBeenNthCalledWith(1, expect.any(String), [accountId]);
      expect(pool.query).toHaveBeenCalledTimes(state.active ? 2 : 1);
      if (state.active) {
        expect(pool.query).toHaveBeenNthCalledWith(2, expect.any(String), ["payments-terms", accountId]);
      }
    });
  });
});
