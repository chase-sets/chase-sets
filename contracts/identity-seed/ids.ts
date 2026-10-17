import type {
  AccountId,
  ApiKeyId,
  ConsentId,
  CredentialId,
  InvitationId,
  MembershipId,
  ShippingAddressId,
  SessionId,
  UserId,
} from "@chase-sets/primitives/typed-ids";

export const identitySeedIds = {
  demo: {
    accountId: "acc_seed_demo_account" as AccountId,
    userId: "usr_seed_demo_user" as UserId,
    membershipId: "mbr_seed_demo_membership" as MembershipId,
    consentId: "cns_seed_demo_terms" as ConsentId,
    credentialId: "crd_seed_demo_password" as CredentialId,
    sessionId: "ses_seed_demo_session" as SessionId,
    apiKeyId: "key_seed_demo_primary" as ApiKeyId,
    shippingAddressId: "adr_seed_demo_shipping" as ShippingAddressId,
  },
  collector: {
    accountId: "acc_seed_collector_account" as AccountId,
    userId: "usr_seed_collector_user" as UserId,
    membershipId: "mbr_seed_collector_membership" as MembershipId,
    consentId: "cns_seed_collector_terms" as ConsentId,
    credentialId: "crd_seed_collector_password" as CredentialId,
    sessionId: "ses_seed_collector_session" as SessionId,
    shippingAddressId: "adr_seed_collector_shipping" as ShippingAddressId,
  },
  valueTrader: {
    accountId: "acc_seed_value_trader_account" as AccountId,
    userId: "usr_seed_value_trader_user" as UserId,
    membershipId: "mbr_seed_value_trader_membership" as MembershipId,
    consentId: "cns_seed_value_trader_terms" as ConsentId,
    credentialId: "crd_seed_value_trader_password" as CredentialId,
    sessionId: "ses_seed_value_trader_session" as SessionId,
  },
  highRollerTrader: {
    accountId: "acc_seed_high_roller_trader_account" as AccountId,
    userId: "usr_seed_high_roller_trader_user" as UserId,
    membershipId: "mbr_seed_high_roller_trader_membership" as MembershipId,
    consentId: "cns_seed_high_roller_trader_terms" as ConsentId,
    credentialId: "crd_seed_high_roller_trader_password" as CredentialId,
    sessionId: "ses_seed_high_roller_trader_session" as SessionId,
  },
  cardVault: {
    accountId: "acc_seed_card_vault_account" as AccountId,
    userId: "usr_seed_card_vault_user" as UserId,
    membershipId: "mbr_seed_card_vault_membership" as MembershipId,
    consentId: "cns_seed_card_vault_terms" as ConsentId,
    credentialId: "crd_seed_card_vault_password" as CredentialId,
    sessionId: "ses_seed_card_vault_session" as SessionId,
  },
  sealedStockroom: {
    accountId: "acc_seed_sealed_stockroom_account" as AccountId,
    userId: "usr_seed_sealed_stockroom_user" as UserId,
    membershipId: "mbr_seed_sealed_stockroom_membership" as MembershipId,
    consentId: "cns_seed_sealed_stockroom_terms" as ConsentId,
    credentialId: "crd_seed_sealed_stockroom_password" as CredentialId,
    sessionId: "ses_seed_sealed_stockroom_session" as SessionId,
  },
  support: {
    accountId: "acc_seed_support_account" as AccountId,
    userId: "usr_seed_support_user" as UserId,
    membershipId: "mbr_seed_support_membership" as MembershipId,
    invitationId: "ivt_seed_support_accept" as InvitationId,
    sessionId: "ses_seed_support_session" as SessionId,
  },
  suspended: {
    accountId: "acc_seed_suspended_account" as AccountId,
    userId: "usr_seed_suspended_user" as UserId,
    membershipId: "mbr_seed_suspended_membership" as MembershipId,
  },
  invitations: {
    declined: "ivt_seed_declined" as InvitationId,
    cancelled: "ivt_seed_cancelled" as InvitationId,
    expired: "ivt_seed_expired" as InvitationId,
  },
  apiKeys: {
    rotatedRevoked: "key_seed_rotated_revoked" as ApiKeyId,
  },
} as const;

export const demoIdentitySeedIds = {
  accountId: identitySeedIds.demo.accountId,
  userId: identitySeedIds.demo.userId,
  membershipId: identitySeedIds.demo.membershipId,
  consentId: identitySeedIds.demo.consentId,
  credentialId: identitySeedIds.demo.credentialId,
} as const;
