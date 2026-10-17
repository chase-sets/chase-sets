import { describe, expect, it } from "vitest";
import { demoIdentitySeedIds, identitySeedIds } from "./ids";

const expectedIdentitySeedIds = {
  demo: {
    accountId: "acc_seed_demo_account",
    userId: "usr_seed_demo_user",
    membershipId: "mbr_seed_demo_membership",
    consentId: "cns_seed_demo_terms",
    credentialId: "crd_seed_demo_password",
    sessionId: "ses_seed_demo_session",
    apiKeyId: "key_seed_demo_primary",
    shippingAddressId: "adr_seed_demo_shipping",
  },
  collector: {
    accountId: "acc_seed_collector_account",
    userId: "usr_seed_collector_user",
    membershipId: "mbr_seed_collector_membership",
    consentId: "cns_seed_collector_terms",
    credentialId: "crd_seed_collector_password",
    sessionId: "ses_seed_collector_session",
    shippingAddressId: "adr_seed_collector_shipping",
  },
  valueTrader: {
    accountId: "acc_seed_value_trader_account",
    userId: "usr_seed_value_trader_user",
    membershipId: "mbr_seed_value_trader_membership",
    consentId: "cns_seed_value_trader_terms",
    credentialId: "crd_seed_value_trader_password",
    sessionId: "ses_seed_value_trader_session",
  },
  highRollerTrader: {
    accountId: "acc_seed_high_roller_trader_account",
    userId: "usr_seed_high_roller_trader_user",
    membershipId: "mbr_seed_high_roller_trader_membership",
    consentId: "cns_seed_high_roller_trader_terms",
    credentialId: "crd_seed_high_roller_trader_password",
    sessionId: "ses_seed_high_roller_trader_session",
  },
  cardVault: {
    accountId: "acc_seed_card_vault_account",
    userId: "usr_seed_card_vault_user",
    membershipId: "mbr_seed_card_vault_membership",
    consentId: "cns_seed_card_vault_terms",
    credentialId: "crd_seed_card_vault_password",
    sessionId: "ses_seed_card_vault_session",
  },
  sealedStockroom: {
    accountId: "acc_seed_sealed_stockroom_account",
    userId: "usr_seed_sealed_stockroom_user",
    membershipId: "mbr_seed_sealed_stockroom_membership",
    consentId: "cns_seed_sealed_stockroom_terms",
    credentialId: "crd_seed_sealed_stockroom_password",
    sessionId: "ses_seed_sealed_stockroom_session",
  },
  support: {
    accountId: "acc_seed_support_account",
    userId: "usr_seed_support_user",
    membershipId: "mbr_seed_support_membership",
    invitationId: "ivt_seed_support_accept",
    sessionId: "ses_seed_support_session",
  },
  suspended: {
    accountId: "acc_seed_suspended_account",
    userId: "usr_seed_suspended_user",
    membershipId: "mbr_seed_suspended_membership",
  },
  invitations: {
    declined: "ivt_seed_declined",
    cancelled: "ivt_seed_cancelled",
    expired: "ivt_seed_expired",
  },
  apiKeys: {
    rotatedRevoked: "key_seed_rotated_revoked",
  },
} as const;

describe("identity seed contract", () => {
  it("identity seed contract preserves exported ids", () => {
    expect(identitySeedIds).toStrictEqual(expectedIdentitySeedIds);
    expect(demoIdentitySeedIds).toStrictEqual({
      accountId: expectedIdentitySeedIds.demo.accountId,
      userId: expectedIdentitySeedIds.demo.userId,
      membershipId: expectedIdentitySeedIds.demo.membershipId,
      consentId: expectedIdentitySeedIds.demo.consentId,
      credentialId: expectedIdentitySeedIds.demo.credentialId,
    });
  });

  it("rejects unmistakable missing-value and altered-value controls", () => {
    const { suspended: _missing, ...missingIdentity } = expectedIdentitySeedIds;
    const alteredIdentity = {
      ...expectedIdentitySeedIds,
      demo: { ...expectedIdentitySeedIds.demo, accountId: "acc_seed_altered_negative_control" },
    };

    expect(identitySeedIds).not.toStrictEqual(missingIdentity);
    expect(identitySeedIds).not.toStrictEqual(alteredIdentity);
  });
});
