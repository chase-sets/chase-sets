import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type AccountSelectionMembershipRow = Readonly<{
  account_id: string;
  account_name: string;
  role_key: string;
}>;

export type AccountSelectionMembership = Readonly<{
  accountId: string;
  accountName: string;
  roleLabel: string;
}>;

const roleLabelTranslationKeys = {
  "platform-admin": "auth.features.accountSelection.readModel.role.platformAdministrator",
  owner: "identity.features.memberships.ui.role.owner",
  manager: "identity.features.memberships.ui.role.manager",
  fulfillment: "identity.features.memberships.ui.role.fulfillment",
  viewer: "identity.features.memberships.ui.role.viewer",
} as const;

function resolveRoleLabel(roleKey: string) {
  const translationKey = roleLabelTranslationKeys[roleKey as keyof typeof roleLabelTranslationKeys];

  return translationKey ? t(translationKey) : t("auth.features.accountSelection.readModel.role.member");
}

export async function listAccountSelectionMemberships(
  db: PgQueryable,
  userId: string,
): Promise<readonly AccountSelectionMembership[]> {
  const result = await db.query<AccountSelectionMembershipRow>(
    `SELECT memberships.account_id,
            COALESCE(NULLIF(TRIM(accounts.display_name), ''), accounts.name) AS account_name,
            memberships.role_key
     FROM auth_identity_user_memberships AS memberships
     INNER JOIN auth_identity_accounts AS accounts
       ON accounts.account_id = memberships.account_id
     WHERE memberships.user_id = $1
       AND memberships.status = 'active'
     ORDER BY memberships.updated_at DESC`,
    [userId],
  );

  return result.rows.map((membership) => ({
    accountId: membership.account_id,
    accountName: membership.account_name,
    roleLabel: resolveRoleLabel(membership.role_key),
  }));
}
