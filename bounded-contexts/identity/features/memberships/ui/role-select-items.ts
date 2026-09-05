import { GRANTABLE_ROLE_KEYS } from "../../../support/runtime-support/common";
import { membershipRoleLabel } from "../../../support/ui-support/value-labels";

export const grantableRoleSelectItems = GRANTABLE_ROLE_KEYS.map((roleKey) => ({
  value: roleKey,
  label: membershipRoleLabel(roleKey),
}));
