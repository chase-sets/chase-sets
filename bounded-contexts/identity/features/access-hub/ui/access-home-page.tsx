import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Form,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  type DataColumn,
} from "@chase-sets/design-system";
import type { Account } from "../../accounts/ui/contracts";
import type { AccessHome } from "../api/contracts";

type AttentionRow = Readonly<{
  id: string;
  kind: string;
  account: string;
  detail: string;
  href: string;
}>;

function accountLabel(account: Pick<Account, "account_id" | "display_name">) {
  return account.display_name || account.account_id;
}

function buildAttentionRows(data: AccessHome): AttentionRow[] {
  return [
    ...data.attention.pending_invitations.map((invitation) => ({
      id: invitation.invitation_id,
      kind: t("identity.features.accessHub.ui.accessHome.pending.invitation"),
      account: invitation.account_display_name ?? invitation.account_name ?? invitation.account_id,
      detail: t("identity.features.accessHub.ui.accessHome.pending.invitation.detail", {
        email: invitation.email,
        role: invitation.role_key,
        expiresAt: invitation.expires_at,
      }),
      href: `/access/accounts/${invitation.account_id}?tab=team&invitation=${invitation.invitation_id}`,
    })),
    ...data.attention.api_keys_needing_rotation.map((apiKey) => ({
      id: apiKey.api_key_id,
      kind: t("identity.features.accessHub.ui.accessHome.api.key.rotation"),
      account: apiKey.account_display_name || apiKey.account_id,
      detail: t("identity.features.accessHub.ui.accessHome.api.key.rotation.detail", {
        name: apiKey.name,
        user: apiKey.user_display_name ?? apiKey.user_primary_email ?? apiKey.user_id,
        dueAt: apiKey.rotation_due_at,
      }),
      href: `/access/accounts/${apiKey.account_id}?tab=api-access&apiKey=${apiKey.api_key_id}`,
    })),
    ...data.attention.suspended_accounts.map((account) => ({
      id: account.account_id,
      kind: t("identity.features.accessHub.ui.accessHome.suspended.account"),
      account: accountLabel(account),
      detail: account.updated_at,
      href: `/access/accounts/${account.account_id}?tab=overview`,
    })),
    ...data.attention.memberships_awaiting_review.map((membership) => ({
      id: membership.membership_id,
      kind: t("identity.features.accessHub.ui.accessHome.membership.review"),
      account: membership.account_display_name ?? membership.account_name ?? membership.account_id,
      detail: t("identity.features.accessHub.ui.accessHome.membership.review.detail", {
        user: membership.user_display_name ?? membership.user_primary_email ?? membership.user_id,
        role: membership.role_key,
      }),
      href: `/access/accounts/${membership.account_id}?tab=team&membership=${membership.membership_id}`,
    })),
  ];
}

const accountColumns: DataColumn<Account>[] = [
  {
    key: "display_name",
    header: t("identity.features.accounts.ui.accountListPage.display.name"),
    cell: (account) => accountLabel(account),
  },
  {
    key: "account_type",
    header: t("identity.features.accounts.ui.accountListPage.type"),
    cell: (account) => account.account_type,
  },
  {
    key: "status",
    header: t("identity.features.accounts.ui.accountListPage.status"),
    cell: (account) => <Badge tone={account.status === "active" ? "success" : "warning"}>{account.status}</Badge>,
  },
  {
    key: "open",
    header: "",
    cell: (account) => (
      <LinkButton href={`/access/accounts/${account.account_id}`} size="sm" tone="secondary">
        {t("identity.features.accessHub.ui.accessHome.open.account")}
      </LinkButton>
    ),
  },
];

const attentionColumns: DataColumn<AttentionRow>[] = [
  { key: "kind", header: t("identity.features.accessHub.ui.accessHome.attention.type"), cell: (row) => row.kind },
  { key: "account", header: t("identity.features.accessHub.ui.accessHome.account"), cell: (row) => row.account },
  { key: "detail", header: t("identity.features.accessHub.ui.accessHome.details"), cell: (row) => row.detail },
  {
    key: "review",
    header: "",
    cell: (row) => (
      <LinkButton href={row.href} size="sm" tone="secondary">
        {t("identity.features.accessHub.ui.accessHome.review")}
      </LinkButton>
    ),
  },
];

export function AccessHomePage({ data, search = "" }: { data: AccessHome; search?: string }) {
  const attention = buildAttentionRows(data);

  return (
    <Page>
      <PageHeader
        eyebrow={t("identity.features.accessHub.ui.accessHome.eyebrow")}
        title={t("identity.features.accessHub.ui.accessHome.title")}
        description={t("identity.features.accessHub.ui.accessHome.description")}
      />
      <PageSection
        title={t("identity.features.accessHub.ui.accessHome.attention")}
        description={t("identity.features.accessHub.ui.accessHome.attention.description")}
      >
        {attention.length > 0 ? (
          <DataTable columns={attentionColumns} rows={attention} />
        ) : (
          <EmptyState
            title={t("identity.features.accessHub.ui.accessHome.attention.empty")}
            description={t("identity.features.accessHub.ui.accessHome.attention.empty.description")}
            icon="check"
          />
        )}
      </PageSection>
      <PageSection
        title={t("identity.features.accessHub.ui.accessHome.account.search")}
        description={t("identity.features.accessHub.ui.accessHome.account.search.description")}
      >
        <Card>
          <Stack gap={4}>
            <Form method="get" spacing="none">
              <Inline align="end" gap={2}>
                <TextInput
                  name="search"
                  label={t("identity.features.accessHub.ui.accessHome.search")}
                  defaultValue={search}
                  placeholder={t("identity.features.accessHub.ui.accessHome.search.placeholder")}
                />
                <Button type="submit" tone="primary">
                  {t("identity.features.accessHub.ui.accessHome.search.action")}
                </Button>
                {search ? (
                  <LinkButton href="/access" tone="secondary">
                    {t("identity.features.accessHub.ui.accessHome.search.clear")}
                  </LinkButton>
                ) : null}
              </Inline>
            </Form>
            <Text tone="secondary">
              {t("identity.features.accessHub.ui.accessHome.account.count", { count: data.account_total })}
            </Text>
            {data.accounts.length > 0 ? (
              <DataTable columns={accountColumns} rows={[...data.accounts]} />
            ) : (
              <EmptyState
                title={t("identity.features.accessHub.ui.accessHome.accounts.empty")}
                description={t("identity.features.accessHub.ui.accessHome.accounts.empty.description")}
                icon="search"
              />
            )}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
