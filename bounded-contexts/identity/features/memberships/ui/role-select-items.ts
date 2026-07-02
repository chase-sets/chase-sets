import { t } from "@chase-sets/localization";
import { GRANTABLE_ROLE_KEYS, type GrantableRoleKey } from "../../../support/runtime-support/common";

const roleLabelTranslationKeys: Record<GrantableRoleKey, string> = {
  owner: "identity.features.memberships.ui.role.owner",
  manager: "identity.features.memberships.ui.role.manager",
  fulfillment: "identity.features.memberships.ui.role.fulfillment",
  viewer: "identity.features.memberships.ui.role.viewer",
};

export const grantableRoleSelectItems = GRANTABLE_ROLE_KEYS.map((roleKey) => ({
  value: roleKey,
  label: t(roleLabelTranslationKeys[roleKey]),
}));
