import { t } from "@chase-sets/localization";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  DataTable,
  DateInput,
  EmptyState,
  Form,
  HiddenInput,
  Inline,
  LinkButton,
  ModalDialog,
  NativeSelect,
  Page,
  PageHeader,
  Stack,
  StatusPill,
  Tabs,
  Text,
  TextInput,
  Timeline,
  type DataColumn,
} from "@chase-sets/design-system";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { AccountBadgeList, accountBadgeKeys, accountBadgeLabels } from "../../accounts/ui/account-badges";
import { ApiKeySecretReveal } from "../../api-keys/ui/api-key-secret-reveal";
import type { OneTimeApiKeySecret } from "../../api-keys/ui/contracts";
import { grantableRoleSelectItems } from "../../memberships/ui/role-select-items";
import type { User } from "../../users/ui/contracts";
import type { AccountAccessHub, AccountAuditEvent } from "../api/contracts";

export const accountAccessHubTabs = ["overview", "team", "api-access", "audit"] as const;
export type AccountAccessHubTab = (typeof accountAccessHubTabs)[number];

const authMethodItems = [
  { value: "password", label: "password" },
  { value: "magic-link", label: "magic-link" },
  { value: "passkey", label: "passkey" },
  { value: "sms-code", label: "sms-code" },
  { value: "social-login", label: "social-login" },
];

function hasPermission(actorPermissions: readonly string[], permission: string) {
  return actorPermissions.includes(permission);
}

function canManageUser(actor: ResolvedActor, userId: string) {
  return (
    hasPermission(actor.permissions, "security.manage") &&
    (actor.roleKey === "platform-admin" || actor.userId === userId)
  );
}

function accountAction(accountId: string, tab: AccountAccessHubTab) {
  return `/access/accounts/${accountId}?tab=${tab}`;
}

function userLabel(user: Pick<User, "user_id" | "display_name" | "primary_email">) {
  return user.display_name || user.primary_email || user.user_id;
}

function formatAuditEvent(event: AccountAuditEvent) {
  return event.event_type
    .replace(/^identity\./, "")
    .split(".")
    .map((part) => part.replaceAll("-", " "))
    .join(" · ");
}

function OverviewPanel({ data, actor }: { data: AccountAccessHub; actor: ResolvedActor }) {
  const account = data.account;
  const canManageAccount = hasPermission(actor.permissions, "accounts.manage");
  const canManageBadges = actor.roleKey === "platform-admin";
  const action = accountAction(account.account_id, "overview");

  return (
    <Stack gap={4}>
      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.accessHub.ui.account.overview.profile")}</Card.Title>
          <Card.Description>
            {t("identity.features.accessHub.ui.account.overview.profile.description")}
          </Card.Description>
        </Card.Header>
        <Card.Body>
          <Inline gap={4}>
            <Stack gap={1}>
              <Text weight="semibold">{t("identity.features.accounts.ui.accountDetailPage.account.id")}</Text>
              <Text tone="secondary">{account.account_id}</Text>
            </Stack>
            <Stack gap={1}>
              <Text weight="semibold">{t("identity.features.accounts.ui.accountDetailPage.account.type")}</Text>
              <Text tone="secondary">{account.account_type}</Text>
            </Stack>
            <Stack gap={1}>
              <Text weight="semibold">{t("identity.features.accounts.ui.accountDetailPage.updated.at")}</Text>
              <Text tone="secondary">{account.updated_at}</Text>
            </Stack>
          </Inline>
          {canManageAccount ? (
            <Form method="post" action={action} spacing="none">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="update-profile" readOnly />
                <TextInput
                  name="name"
                  label={t("identity.features.accounts.ui.accountDetailPage.legal.name")}
                  defaultValue={account.name}
                  required
                />
                <TextInput
                  name="displayName"
                  label={t("identity.features.accounts.ui.accountDetailPage.display.name")}
                  defaultValue={account.display_name}
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.accounts.ui.accountDetailPage.update.profile")}
                </Button>
              </Stack>
            </Form>
          ) : null}
        </Card.Body>
      </Card>

      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.accessHub.ui.account.overview.lifecycle")}</Card.Title>
          <Card.Description>
            {t("identity.features.accessHub.ui.account.overview.lifecycle.description")}
          </Card.Description>
        </Card.Header>
        <Card.Body>
          <Inline align="center" gap={2}>
            <StatusPill>{account.status}</StatusPill>
            {canManageAccount && account.status === "active" ? (
              <ModalDialog
                title={t("identity.features.accounts.ui.accountDetailPage.suspend.confirm.title", {
                  account: account.display_name,
                })}
                description={t("identity.features.accounts.ui.accountDetailPage.suspend.confirm.description", {
                  account: account.display_name,
                })}
                trigger={
                  <Button type="button" tone="danger">
                    {t("identity.features.accounts.ui.accountDetailPage.suspend")}
                  </Button>
                }
              >
                <Form method="post" action={action} spacing="none">
                  <HiddenInput type="hidden" name="intent" value="suspend" readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.accounts.ui.accountDetailPage.suspend.confirm.action")}
                  </Button>
                </Form>
              </ModalDialog>
            ) : null}
            {canManageAccount && account.status === "suspended" ? (
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="reactivate" readOnly />
                <Button type="submit" tone="primary">
                  {t("identity.features.accounts.ui.accountDetailPage.reactivate")}
                </Button>
              </Form>
            ) : null}
            {canManageAccount && account.status !== "closed" ? (
              <ModalDialog
                title={t("identity.features.accessHub.ui.account.close.confirm.title", {
                  account: account.display_name,
                })}
                description={t("identity.features.accessHub.ui.account.close.confirm.description", {
                  account: account.display_name,
                })}
                trigger={
                  <Button type="button" tone="danger">
                    {t("identity.features.accounts.ui.accountDetailPage.close")}
                  </Button>
                }
              >
                <Form method="post" action={action} spacing="none">
                  <HiddenInput type="hidden" name="intent" value="close" readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.accessHub.ui.account.close.confirm.action")}
                  </Button>
                </Form>
              </ModalDialog>
            ) : null}
          </Inline>
        </Card.Body>
      </Card>

      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.accounts.ui.accountDetailPage.account.badges")}</Card.Title>
        </Card.Header>
        <Card.Body>
          <AccountBadgeList badges={account.badges} founderNumber={account.founder_number} />
          {canManageBadges ? (
            <Inline gap={2}>
              {accountBadgeKeys
                .filter((badgeKey) => badgeKey !== "founding-account")
                .map((badgeKey) => {
                  const assigned = account.badges.includes(badgeKey);
                  const badge = accountBadgeLabels[badgeKey];
                  return (
                    <Form key={badgeKey} method="post" action={action} spacing="none">
                      <HiddenInput
                        type="hidden"
                        name="intent"
                        value={assigned ? "remove-account-badge" : "assign-account-badge"}
                        readOnly
                      />
                      <HiddenInput type="hidden" name="badgeKey" value={badgeKey} readOnly />
                      <Button type="submit" tone={assigned ? "secondary" : "primary"}>
                        {assigned
                          ? t("identity.features.accounts.ui.accountDetailPage.remove.account.badge", { badge })
                          : t("identity.features.accounts.ui.accountDetailPage.assign.account.badge", { badge })}
                      </Button>
                    </Form>
                  );
                })}
            </Inline>
          ) : null}
        </Card.Body>
      </Card>
    </Stack>
  );
}

function UserAccessCard({ user, actor, accountId }: { user: User; actor: ResolvedActor; accountId: string }) {
  const canManage = canManageUser(actor, user.user_id);
  if (!canManage) {
    return null;
  }
  const action = accountAction(accountId, "team");

  return (
    <Card elevation="elevated">
      <Card.Header>
        <Card.Title>{userLabel(user)}</Card.Title>
        <Card.Description>{user.user_id}</Card.Description>
      </Card.Header>
      <Card.Body>
        <Form method="post" action={action} spacing="none">
          <Stack direction="row" align="end" gap={2}>
            <HiddenInput type="hidden" name="intent" value="update-user-profile" readOnly />
            <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
            <TextInput
              name="displayName"
              label={t("identity.features.users.ui.userDetailPage.display.name")}
              defaultValue={user.display_name}
              required
            />
            <TextInput
              name="givenName"
              label={t("identity.features.users.ui.userDetailPage.given.name")}
              defaultValue={user.given_name}
            />
            <TextInput
              name="familyName"
              label={t("identity.features.users.ui.userDetailPage.family.name")}
              defaultValue={user.family_name}
            />
            <Button type="submit" tone="secondary">
              {t("identity.features.users.ui.userDetailPage.update.profile")}
            </Button>
          </Stack>
        </Form>
        <Inline gap={2}>
          {user.status === "active" ? (
            <ModalDialog
              title={t("identity.features.users.ui.userDetailPage.suspend.confirm.title", { user: userLabel(user) })}
              description={t("identity.features.users.ui.userDetailPage.suspend.confirm.description", {
                user: userLabel(user),
              })}
              trigger={
                <Button type="button" tone="danger">
                  {t("identity.features.users.ui.userDetailPage.suspend")}
                </Button>
              }
            >
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="suspend-user" readOnly />
                <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.users.ui.userDetailPage.suspend.confirm.action")}
                </Button>
              </Form>
            </ModalDialog>
          ) : (
            <Form method="post" action={action} spacing="none">
              <HiddenInput type="hidden" name="intent" value="reactivate-user" readOnly />
              <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.users.ui.userDetailPage.reactivate")}
              </Button>
            </Form>
          )}
        </Inline>
        <Form method="post" action={action} spacing="none">
          <Stack direction="row" align="end" gap={2}>
            <HiddenInput type="hidden" name="intent" value="add-user-contact-method" readOnly />
            <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
            <NativeSelect
              name="contactMethodType"
              label={t("identity.features.users.ui.userDetailPage.contact.method.type")}
              items={[
                { value: "email", label: t("identity.features.users.ui.userDetailPage.email") },
                { value: "phone", label: t("identity.features.users.ui.userDetailPage.phone") },
              ]}
              required
            />
            <TextInput
              name="contactMethodValue"
              label={t("identity.features.users.ui.userDetailPage.contact.method.value")}
              required
            />
            <Button type="submit" tone="secondary">
              {t("identity.features.users.ui.userDetailPage.add.contact.method")}
            </Button>
          </Stack>
        </Form>
        {user.contact_methods.map((method) => (
          <Inline key={method.contactMethodId} align="center" gap={2}>
            <Text>
              {method.type}: {method.value}
            </Text>
            <Badge tone={method.verifiedAt ? "success" : "warning"}>
              {method.verifiedAt
                ? t("identity.features.users.ui.userDetailPage.verified")
                : t("identity.features.users.ui.userDetailPage.unverified")}
            </Badge>
            {!method.verifiedAt ? (
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="verify-user-contact-method" readOnly />
                <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
                <HiddenInput type="hidden" name="contactMethodId" value={method.contactMethodId} readOnly />
                <Button type="submit" size="sm" tone="secondary">
                  {t("identity.features.users.ui.userDetailPage.verify")}
                </Button>
              </Form>
            ) : null}
          </Inline>
        ))}
        <Form method="post" action={action} spacing="none">
          <Stack direction="row" align="end" gap={2}>
            <HiddenInput type="hidden" name="intent" value="enable-user-auth-method" readOnly />
            <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
            <NativeSelect
              name="authMethod"
              label={t("identity.features.users.ui.userDetailPage.auth.method")}
              items={authMethodItems}
              required
            />
            <Button type="submit" tone="secondary">
              {t("identity.features.users.ui.userDetailPage.enable.auth.method")}
            </Button>
          </Stack>
        </Form>
        <Inline gap={2}>
          {user.auth_methods.map((authMethod) => (
            <Form key={authMethod} method="post" action={action} spacing="none">
              <HiddenInput type="hidden" name="intent" value="disable-user-auth-method" readOnly />
              <HiddenInput type="hidden" name="userId" value={user.user_id} readOnly />
              <HiddenInput type="hidden" name="authMethod" value={authMethod} readOnly />
              <Button type="submit" size="sm" tone="danger">
                {t("identity.features.accessHub.ui.account.disable.auth.method", { authMethod })}
              </Button>
            </Form>
          ))}
        </Inline>
      </Card.Body>
    </Card>
  );
}

function TeamPanel({ data, actor }: { data: AccountAccessHub; actor: ResolvedActor }) {
  const canManageMemberships = hasPermission(actor.permissions, "memberships.manage");
  const action = accountAction(data.account.account_id, "team");
  const membershipColumns: DataColumn<(typeof data.memberships)[number]>[] = [
    {
      key: "user",
      header: t("identity.features.memberships.ui.membershipListPage.user"),
      cell: (membership) => membership.user_display_name ?? membership.user_primary_email ?? membership.user_id,
    },
    {
      key: "role",
      header: t("identity.features.memberships.ui.membershipListPage.role"),
      cell: (membership) => membership.role_key,
    },
    {
      key: "status",
      header: t("identity.features.memberships.ui.membershipListPage.status"),
      cell: (membership) => <StatusPill>{membership.status}</StatusPill>,
    },
    {
      key: "actions",
      header: "",
      cell: (membership) =>
        canManageMemberships ? (
          <Inline gap={2}>
            {membership.status === "active" ? (
              <>
                <Form method="post" action={action} spacing="none">
                  <Stack direction="row" align="end" gap={2}>
                    <HiddenInput type="hidden" name="intent" value="change-membership-role" readOnly />
                    <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                    <NativeSelect
                      name="roleKey"
                      label={t("identity.features.memberships.ui.membershipDetailPage.role")}
                      defaultValue={membership.role_key}
                      items={grantableRoleSelectItems}
                    />
                    <Button type="submit" size="sm" tone="secondary">
                      {t("identity.features.memberships.ui.membershipDetailPage.change.role")}
                    </Button>
                  </Stack>
                </Form>
                <ModalDialog
                  title={t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.title", {
                    user: membership.user_display_name ?? membership.user_primary_email ?? membership.user_id,
                  })}
                  description={t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.description", {
                    user: membership.user_display_name ?? membership.user_primary_email ?? membership.user_id,
                    account: data.account.display_name,
                  })}
                  trigger={
                    <Button type="button" size="sm" tone="danger">
                      {t("identity.features.memberships.ui.membershipDetailPage.revoke")}
                    </Button>
                  }
                >
                  <Form method="post" action={action} spacing="none">
                    <HiddenInput type="hidden" name="intent" value="revoke-membership" readOnly />
                    <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                    <Button type="submit" tone="danger">
                      {t("identity.features.memberships.ui.membershipDetailPage.revoke.confirm.action")}
                    </Button>
                  </Form>
                </ModalDialog>
              </>
            ) : (
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="reinstate-membership" readOnly />
                <HiddenInput type="hidden" name="membershipId" value={membership.membership_id} readOnly />
                <Button type="submit" size="sm" tone="primary">
                  {t("identity.features.memberships.ui.membershipDetailPage.reinstate")}
                </Button>
              </Form>
            )}
          </Inline>
        ) : null,
    },
  ];

  const invitationColumns: DataColumn<(typeof data.invitations)[number]>[] = [
    {
      key: "email",
      header: t("identity.features.invitations.ui.invitationListPage.email"),
      cell: (invitation) => invitation.email,
    },
    {
      key: "role",
      header: t("identity.features.invitations.ui.invitationListPage.role"),
      cell: (invitation) => invitation.role_key,
    },
    {
      key: "status",
      header: t("identity.features.invitations.ui.invitationListPage.status"),
      cell: (invitation) => <StatusPill>{invitation.status}</StatusPill>,
    },
    {
      key: "actions",
      header: "",
      cell: (invitation) =>
        canManageMemberships && invitation.status === "pending" ? (
          <Inline gap={2}>
            <Form method="post" action={action} spacing="none">
              <HiddenInput type="hidden" name="intent" value="resend-invitation" readOnly />
              <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
              <HiddenInput type="hidden" name="expiresAt" value={invitation.expires_at} readOnly />
              <Button type="submit" size="sm" tone="secondary">
                {t("identity.features.invitations.ui.invitationDetailPage.resend")}
              </Button>
            </Form>
            <ModalDialog
              title={t("identity.features.invitations.ui.invitationDetailPage.cancel.confirm.title", {
                email: invitation.email,
              })}
              description={t("identity.features.invitations.ui.invitationDetailPage.cancel.confirm.description", {
                email: invitation.email,
                account: data.account.display_name,
              })}
              trigger={
                <Button type="button" size="sm" tone="danger">
                  {t("identity.features.invitations.ui.invitationDetailPage.cancel")}
                </Button>
              }
            >
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="cancel-invitation" readOnly />
                <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.invitations.ui.invitationDetailPage.cancel.confirm.action")}
                </Button>
              </Form>
            </ModalDialog>
            <Form method="post" action={action} spacing="none">
              <HiddenInput type="hidden" name="intent" value="decline-invitation" readOnly />
              <HiddenInput type="hidden" name="invitationId" value={invitation.invitation_id} readOnly />
              <Button type="submit" size="sm" tone="secondary">
                {t("identity.features.invitations.ui.invitationDetailPage.decline")}
              </Button>
            </Form>
          </Inline>
        ) : null,
    },
  ];

  return (
    <Stack gap={4}>
      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.accessHub.ui.account.team")}</Card.Title>
          <Card.Description>
            {t("identity.features.memberships.ui.accountTeamPage.manage.the.people.who.can.act")}
          </Card.Description>
        </Card.Header>
        <Card.Body>
          {canManageMemberships ? (
            <ModalDialog
              title={t("identity.features.accessHub.ui.account.invite.title")}
              description={t("identity.features.accessHub.ui.account.invite.description", {
                account: data.account.display_name,
              })}
              trigger={
                <Button type="button" tone="primary">
                  {t("identity.features.accounts.ui.accountDetailPage.invite.member")}
                </Button>
              }
            >
              <Form method="post" action={action} spacing="none">
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="intent" value="create-invitation" readOnly />
                  <TextInput
                    name="email"
                    label={t("identity.features.accounts.ui.accountDetailPage.invite.email")}
                    type="email"
                    required
                  />
                  <NativeSelect
                    name="roleKey"
                    label={t("identity.features.accounts.ui.accountDetailPage.invite.role")}
                    defaultValue="viewer"
                    items={grantableRoleSelectItems}
                  />
                  <Button type="submit" tone="primary">
                    {t("identity.features.memberships.ui.accountTeamPage.invite")}
                  </Button>
                </Stack>
              </Form>
            </ModalDialog>
          ) : null}
          {data.memberships.length > 0 ? (
            <DataTable columns={membershipColumns} rows={[...data.memberships]} />
          ) : (
            <EmptyState
              title={t("identity.features.accessHub.ui.account.team.empty")}
              description={t("identity.features.accessHub.ui.account.team.empty.description")}
              icon="user"
            />
          )}
        </Card.Body>
      </Card>

      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.invitations.ui.invitationListPage.invitations")}</Card.Title>
        </Card.Header>
        <Card.Body>
          {data.invitations.length > 0 ? (
            <DataTable columns={invitationColumns} rows={[...data.invitations]} />
          ) : (
            <Text tone="secondary">{t("identity.features.invitations.ui.invitationListPage.no.invitations.yet")}</Text>
          )}
        </Card.Body>
      </Card>

      {data.users.map((user) => (
        <UserAccessCard key={user.user_id} user={user} actor={actor} accountId={data.account.account_id} />
      ))}
    </Stack>
  );
}

function ApiAccessPanel({
  data,
  actor,
  oneTimeSecret,
}: {
  data: AccountAccessHub;
  actor: ResolvedActor;
  oneTimeSecret?: OneTimeApiKeySecret | null;
}) {
  const action = accountAction(data.account.account_id, "api-access");
  const manageableUsers = data.users.filter((user) => canManageUser(actor, user.user_id));
  const userItems = manageableUsers.map((user) => ({
    value: user.user_id,
    label: user.primary_email ? `${userLabel(user)} (${user.primary_email})` : userLabel(user),
  }));
  const columns: DataColumn<(typeof data.api_keys)[number]>[] = [
    { key: "name", header: t("identity.features.apiKeys.ui.apiKeyListPage.name"), cell: (apiKey) => apiKey.name },
    {
      key: "user",
      header: t("identity.features.apiKeys.ui.apiKeyListPage.user"),
      cell: (apiKey) => apiKey.user_display_name ?? apiKey.user_primary_email ?? apiKey.user_id,
    },
    {
      key: "prefix",
      header: t("identity.features.apiKeys.ui.apiKeyListPage.prefix"),
      cell: (apiKey) => apiKey.key_prefix,
    },
    {
      key: "status",
      header: t("identity.features.apiKeys.ui.apiKeyListPage.status"),
      cell: (apiKey) => <StatusPill>{apiKey.status}</StatusPill>,
    },
    {
      key: "actions",
      header: "",
      cell: (apiKey) =>
        apiKey.status === "active" && canManageUser(actor, apiKey.user_id) ? (
          <Inline gap={2}>
            <Form method="post" action={action} spacing="none">
              <HiddenInput type="hidden" name="intent" value="rotate-api-key" readOnly />
              <HiddenInput type="hidden" name="apiKeyId" value={apiKey.api_key_id} readOnly />
              <Button type="submit" size="sm" tone="secondary">
                {t("identity.features.apiKeys.ui.apiKeyDetailPage.rotate")}
              </Button>
            </Form>
            <ModalDialog
              title={t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.title", {
                name: apiKey.name,
              })}
              description={t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.description", {
                name: apiKey.name,
              })}
              trigger={
                <Button type="button" size="sm" tone="danger">
                  {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke")}
                </Button>
              }
            >
              <Form method="post" action={action} spacing="none">
                <HiddenInput type="hidden" name="intent" value="revoke-api-key" readOnly />
                <HiddenInput type="hidden" name="apiKeyId" value={apiKey.api_key_id} readOnly />
                <Button type="submit" tone="danger">
                  {t("identity.features.apiKeys.ui.apiKeyDetailPage.revoke.confirm.action")}
                </Button>
              </Form>
            </ModalDialog>
          </Inline>
        ) : null,
    },
  ];

  return (
    <Stack gap={4}>
      <ApiKeySecretReveal secret={oneTimeSecret} />
      <Card elevation="tinted">
        <Card.Header>
          <Card.Title>{t("identity.features.accessHub.ui.account.api.access")}</Card.Title>
          <Card.Description>{t("identity.features.accessHub.ui.account.api.access.description")}</Card.Description>
        </Card.Header>
        <Card.Body>
          {userItems.length > 0 ? (
            <Form method="post" action={action} spacing="none">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="create-api-key" readOnly />
                <NativeSelect
                  name="userId"
                  label={t("identity.features.apiKeys.ui.apiKeyListPage.user")}
                  items={userItems}
                  required
                />
                <TextInput
                  name="apiKeyName"
                  label={t("identity.features.users.ui.userDetailPage.api.key.name")}
                  required
                />
                <Button type="submit" tone="primary">
                  {t("identity.features.users.ui.userDetailPage.create.api.key")}
                </Button>
              </Stack>
            </Form>
          ) : null}
          {data.api_keys.length > 0 ? (
            <DataTable columns={columns} rows={[...data.api_keys]} />
          ) : (
            <EmptyState
              title={t("identity.features.apiKeys.ui.apiKeyListPage.no.api.keys.yet")}
              description={t("identity.features.accessHub.ui.account.api.access.empty.description")}
              icon="settings"
            />
          )}
        </Card.Body>
      </Card>
    </Stack>
  );
}

function AuditPanel({ events }: { events: readonly AccountAuditEvent[] }) {
  return events.length > 0 ? (
    <Timeline
      items={events.map((event) => ({
        title: formatAuditEvent(event),
        description: t("identity.features.accessHub.ui.account.audit.event.description", {
          streamId: event.stream_id,
          performedByUserId: event.performed_by_user_id,
        }),
        timestamp: event.recorded_at,
      }))}
    />
  ) : (
    <EmptyState
      title={t("identity.features.accessHub.ui.account.audit.empty")}
      description={t("identity.features.accessHub.ui.account.audit.empty.description")}
      icon="info"
    />
  );
}

export function AccountAccessHubPage({
  data,
  actor,
  initialTab = "overview",
  oneTimeSecret,
}: {
  data: AccountAccessHub;
  actor: ResolvedActor;
  initialTab?: AccountAccessHubTab;
  oneTimeSecret?: OneTimeApiKeySecret | null;
}) {
  const actorPermissions = actor.permissions;

  return (
    <Page>
      <Breadcrumbs
        items={[
          { label: t("identity.features.accessHub.ui.accessHome.title"), href: "/access" },
          { label: data.account.display_name },
        ]}
      />
      <PageHeader
        eyebrow={t("identity.features.accessHub.ui.account.eyebrow")}
        title={data.account.display_name}
        description={t("identity.features.accessHub.ui.account.description")}
        actions={
          hasPermission(actorPermissions, "wallet-adjustments.view") ? (
            <LinkButton
              href={`/commerce/wallet-workbench/${data.account.account_id}?accountName=${encodeURIComponent(data.account.display_name)}`}
              tone="secondary"
            >
              {t("identity.features.accounts.ui.accountDetailPage.view.wallet")}
            </LinkButton>
          ) : null
        }
      />
      <Inline align="center" gap={3}>
        <AccountBadgeList badges={data.account.badges} founderNumber={data.account.founder_number} />
        <StatusPill>{data.account.status}</StatusPill>
      </Inline>
      <Tabs
        defaultValue={initialTab}
        items={[
          {
            value: "overview",
            label: t("identity.features.accessHub.ui.account.tab.overview"),
            content: <OverviewPanel data={data} actor={actor} />,
          },
          {
            value: "team",
            label: t("identity.features.accessHub.ui.account.tab.team"),
            badge: String(
              data.memberships.length + data.invitations.filter((item) => item.status === "pending").length,
            ),
            content: <TeamPanel data={data} actor={actor} />,
          },
          {
            value: "api-access",
            label: t("identity.features.accessHub.ui.account.tab.api.access"),
            badge: String(data.api_keys.filter((item) => item.status === "active").length),
            content: <ApiAccessPanel data={data} actor={actor} oneTimeSecret={oneTimeSecret} />,
          },
          {
            value: "audit",
            label: t("identity.features.accessHub.ui.account.tab.audit"),
            content: <AuditPanel events={data.audit_events} />,
          },
        ]}
      />
    </Page>
  );
}
