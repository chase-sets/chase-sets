import { describe, expect, it } from "vitest";
import {
  GRANTABLE_ROLE_KEYS,
  ROLE_KEYS,
  type AccountType,
  type AuthMethodKey,
  type ContactMethodType,
} from "../runtime-support/common";
import { IDENTITY_CONSENT_POLICY_KEYS } from "../../features/consents/domain/terms-of-service-policy";
import {
  IDENTITY_ACCOUNT_STATUSES,
  IDENTITY_API_KEY_STATUSES,
  IDENTITY_INVITATION_STATUSES,
  IDENTITY_MEMBERSHIP_STATUSES,
  IDENTITY_USER_STATUSES,
} from "../route-support/list-filters";
import {
  accountStatusLabel,
  accountTypeLabel,
  apiKeyStatusLabel,
  consentPolicyLabel,
  consentStatusLabel,
  consentVersionLabel,
  contactMethodTypeLabel,
  contactMethodTypeSelectItems,
  identityAuthenticationMethodLabel,
  identityAuthenticationMethodSelectItems,
  invitationStatusLabel,
  membershipRoleLabel,
  membershipStatusLabel,
  userStatusLabel,
} from "./value-labels";

describe("Identity value labels", () => {
  it("labels every current Identity value", () => {
    const accountTypes = ["personal", "business", "enterprise"] as const satisfies readonly AccountType[];
    const consentStatuses = ["recorded", "withdrawn"] as const;
    const contactMethodTypes = ["email", "phone"] as const satisfies readonly ContactMethodType[];

    expect(accountTypes.map((value) => accountTypeLabel(value))).toEqual(["Personal", "Business", "Enterprise"]);
    expect(IDENTITY_ACCOUNT_STATUSES.map((value) => accountStatusLabel(value))).toEqual([
      "Active",
      "Suspended",
      "Closed",
    ]);
    expect(IDENTITY_USER_STATUSES.map((value) => userStatusLabel(value))).toEqual(["Active", "Suspended"]);
    expect(ROLE_KEYS.map((value) => membershipRoleLabel(value))).toEqual([
      "Platform administrator",
      "Owner",
      "Manager",
      "Fulfillment",
      "Viewer",
    ]);
    expect(IDENTITY_MEMBERSHIP_STATUSES.map((value) => membershipStatusLabel(value))).toEqual(["Active", "Revoked"]);
    expect(IDENTITY_INVITATION_STATUSES.map((value) => invitationStatusLabel(value))).toEqual([
      "Pending",
      "Accepted",
      "Declined",
      "Cancelled",
      "Expired",
    ]);
    expect(IDENTITY_API_KEY_STATUSES.map((value) => apiKeyStatusLabel(value))).toEqual(["Active", "Revoked"]);
    expect(IDENTITY_CONSENT_POLICY_KEYS.map((value) => consentPolicyLabel(value))).toEqual([
      "Terms of Service",
      "Privacy Policy",
      "Seller Agreement",
      "Payments Terms",
    ]);
    expect(consentStatuses.map((value) => consentStatusLabel(value))).toEqual(["Recorded", "Withdrawn"]);
    expect(contactMethodTypes.map((value) => contactMethodTypeLabel(value))).toEqual(["Email", "Phone"]);
  });

  it("keeps raw selectable values and order distinct from presentation labels", () => {
    const expectedAuthMethods = [
      "password",
      "magic-link",
      "passkey",
      "sms-code",
      "social-login",
    ] as const satisfies readonly AuthMethodKey[];

    expect(identityAuthenticationMethodSelectItems.map((item) => item.value)).toEqual(expectedAuthMethods);
    expect(identityAuthenticationMethodSelectItems.map((item) => item.label)).toEqual([
      "Password",
      "Magic link",
      "Passkey",
      "SMS code",
      "Social login",
    ]);
    expect(contactMethodTypeSelectItems.map((item) => item.value)).toEqual(["email", "phone"]);
    expect(GRANTABLE_ROLE_KEYS).toEqual(["owner", "manager", "fulfillment", "viewer"]);
    expect(ROLE_KEYS).toContain("platform-admin");
  });

  it("uses safe fallbacks without treating unknown values as allowed values", () => {
    expect(identityAuthenticationMethodLabel("future-method")).toBe(
      "Unrecognized authentication method: Future Method",
    );
    expect(accountStatusLabel("future-status")).toBe("Unrecognized Account status: Future Status");
    expect(accountStatusLabel("usr_unsafe")).toBe("Unrecognized Account status");
    expect(consentPolicyLabel("person@example.com")).toBe("Unrecognized consent policy");
    expect(consentVersionLabel("v3")).toBe("Version v3");
    expect(consentVersionLabel("usr_unsafe")).toBe("Version unavailable");
  });
});
