import type {
  AccountId,
  ApiKeyId,
  ConsentId,
  CredentialId,
  InvitationId,
  MembershipId,
  SessionId,
  UserId,
} from "@chase-sets/primitives/typed-ids";

export const identitySeedIds = {
  seller: {
    accountId: "acc_seed_demo_account" as AccountId,
    userId: "usr_seed_demo_user" as UserId,
    membershipId: "mbr_seed_demo_membership" as MembershipId,
    consentId: "cns_seed_demo_terms" as ConsentId,
    credentialId: "crd_seed_demo_password" as CredentialId,
    sessionId: "ses_seed_demo_session" as SessionId,
    apiKeyId: "key_seed_demo_primary" as ApiKeyId,
  },
  buyer: {
    accountId: "acc_seed_buyer_account" as AccountId,
    userId: "usr_seed_buyer_user" as UserId,
    membershipId: "mbr_seed_buyer_membership" as MembershipId,
    consentId: "cns_seed_buyer_terms" as ConsentId,
    credentialId: "crd_seed_buyer_password" as CredentialId,
    sessionId: "ses_seed_buyer_session" as SessionId,
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
  accountId: identitySeedIds.seller.accountId,
  userId: identitySeedIds.seller.userId,
  membershipId: identitySeedIds.seller.membershipId,
  consentId: identitySeedIds.seller.consentId,
  credentialId: identitySeedIds.seller.credentialId,
} as const;
