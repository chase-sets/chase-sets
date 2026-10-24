import { useState } from "react";
import { useNavigation, useSubmit } from "react-router";
import { t } from "@chase-sets/localization";
import { formatDateTime, formatMoney } from "@chase-sets/localization";
import { centsToMoneyAmount } from "@chase-sets/primitives/money";
import { AGENT_OAUTH_KNOWN_SCOPE_FAMILIES } from "@chase-sets/auth-context";
import {
  AdminResourceDetailPage,
  AlertDialog,
  Badge,
  Button,
  CheckboxGroup,
  CopyButton,
  CurrencyInput,
  DataTable,
  EvidenceCodeBlock,
  HiddenInput,
  Inline,
  List,
  Stack,
  Switch,
  TextInput,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import type { AgentGrant, AgentGrantActivityRecord, AgentGrantWebhook, AgentGrantRevocationReceipt } from "./contracts";
import { AGENT_GRANT_PAYMENT_RAILS } from "./contracts";
import {
  agentGrantActivityOutcomeTone,
  agentGrantMandateCapLabel,
  agentGrantPaymentRailLabel,
  agentGrantStatusTone,
} from "./agent-grant-presentation";
import {
  agentGrantOutcomeLabel,
  agentGrantStatusLabel,
  authDateUnavailable,
} from "../../../support/ui-support/value-labels";

function clientLabel(grant: AgentGrant) {
  return grant.client_name ?? grant.client_uri ?? grant.platform_profile_url;
}

function GrantedScopes({ scopes }: { scopes: readonly string[] }) {
  const grantedFamilies = AGENT_OAUTH_KNOWN_SCOPE_FAMILIES.map((family) => ({
    family,
    granted: family.scopes.filter((scope) => scopes.includes(scope.scope)),
  })).filter((entry) => entry.granted.length > 0);

  if (grantedFamilies.length === 0) {
    return <Text tone="secondary">{t("auth.features.agentGrants.ui.agentGrantDetailPage.no.scopes")}</Text>;
  }

  return (
    <Stack gap={3}>
      {grantedFamilies.map(({ family, granted }) => (
        <Stack key={family.family} gap={1}>
          <Text weight="semibold">{family.label}</Text>
          <List items={granted.map((scope) => `${scope.label} — ${scope.description}`)} />
        </Stack>
      ))}
    </Stack>
  );
}

function SpendSummary({ grant }: { grant: AgentGrant }) {
  if (!grant.spending_mandate || !grant.spend) {
    return <Text tone="secondary">{t("auth.features.agentGrants.ui.agentGrantDetailPage.no.spend.data")}</Text>;
  }

  const mandate = grant.spending_mandate;
  const spend = grant.spend;
  return (
    <Stack gap={1}>
      <Text>
        {t("auth.features.agentGrants.ui.agentGrantDetailPage.spend.today", {
          spent: formatMoney(centsToMoneyAmount(spend.daily_cents), "USD"),
          cap: agentGrantMandateCapLabel(mandate.daily_cap_cents),
        })}
      </Text>
      <Text>
        {t("auth.features.agentGrants.ui.agentGrantDetailPage.spend.this.month", {
          spent: formatMoney(centsToMoneyAmount(spend.monthly_cents), "USD"),
          cap: agentGrantMandateCapLabel(mandate.monthly_cap_cents),
        })}
      </Text>
      <Text tone="secondary">
        {t("auth.features.agentGrants.ui.agentGrantDetailPage.spend.per.order.cap", {
          cap: agentGrantMandateCapLabel(mandate.max_per_order_cents),
        })}
      </Text>
    </Stack>
  );
}

function MandateForm({ grant }: { grant: AgentGrant }) {
  const mandate = grant.spending_mandate;
  const [allowedRails, setAllowedRails] = useState<string[]>([...(mandate?.allowed_rails ?? ["handoff-only"])]);

  return (
    <RouterForm spacing="md" method="post">
      <Stack gap={3}>
        <HiddenInput type="hidden" name="intent" value="update-mandate" readOnly />
        <CurrencyInput
          label={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.max.per.order")}
          name="max_per_order_amount"
          currencyCode="USD"
          defaultValue={
            mandate?.max_per_order_cents != null ? centsToMoneyAmount(mandate.max_per_order_cents) : undefined
          }
          min="0"
          step="0.01"
          placeholder={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.no.cap.placeholder")}
        />
        <CurrencyInput
          label={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.daily.cap")}
          name="daily_cap_amount"
          currencyCode="USD"
          defaultValue={mandate?.daily_cap_cents != null ? centsToMoneyAmount(mandate.daily_cap_cents) : undefined}
          min="0"
          step="0.01"
          placeholder={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.no.cap.placeholder")}
        />
        <CurrencyInput
          label={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.monthly.cap")}
          name="monthly_cap_amount"
          currencyCode="USD"
          defaultValue={mandate?.monthly_cap_cents != null ? centsToMoneyAmount(mandate.monthly_cap_cents) : undefined}
          min="0"
          step="0.01"
          placeholder={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.no.cap.placeholder")}
        />
        <Switch
          label={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.human.present.required")}
          description={t(
            "auth.features.agentGrants.ui.agentGrantDetailPage.mandate.human.present.required.description",
          )}
          name="human_present_required"
          value="true"
          uncheckedValue="false"
          defaultChecked={mandate?.human_present_required ?? true}
        />
        <CheckboxGroup
          label={t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.allowed.rails")}
          name="allowed_rails"
          items={AGENT_GRANT_PAYMENT_RAILS.map((rail) => ({ value: rail, label: agentGrantPaymentRailLabel(rail) }))}
          values={allowedRails}
          onValuesChange={setAllowedRails}
        />
        <Inline>
          <Button type="submit">{t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate.save")}</Button>
        </Inline>
      </Stack>
    </RouterForm>
  );
}

const activityColumns: DataColumn<AgentGrantActivityRecord>[] = [
  {
    key: "occurred_at",
    header: t("auth.features.agentGrants.ui.agentGrantDetailPage.activity.when"),
    cell: (row) => formatDateTime(row.occurred_at, { preset: "short", fallback: authDateUnavailable() }),
  },
  {
    key: "tool",
    header: t("auth.features.agentGrants.ui.agentGrantDetailPage.activity.tool"),
    cell: (row) => row.tool_name ?? row.resource_uri ?? row.method,
  },
  {
    key: "outcome",
    header: t("auth.features.agentGrants.ui.agentGrantDetailPage.activity.outcome"),
    cell: (row) => (
      <Badge tone={agentGrantActivityOutcomeTone(row.outcome)}>{agentGrantOutcomeLabel(row.outcome)}</Badge>
    ),
  },
  {
    key: "reason",
    header: t("auth.features.agentGrants.ui.agentGrantDetailPage.activity.reason"),
    cell: (row) => row.reason ?? "—",
  },
];

function ActivityTable({ activity }: { activity: readonly AgentGrantActivityRecord[] }) {
  if (activity.length === 0) {
    return <Text tone="secondary">{t("auth.features.agentGrants.ui.agentGrantDetailPage.no.activity.yet")}</Text>;
  }

  return <DataTable columns={activityColumns} rows={[...activity]} />;
}

function WebhookForm({
  webhook,
  savedWebhook,
}: {
  webhook: AgentGrantWebhook | null;
  savedWebhook?: AgentGrantWebhook | null;
}) {
  const current = savedWebhook === undefined ? webhook : savedWebhook;
  return (
    <Stack gap={3}>
      <Text tone="secondary">{t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.description")}</Text>
      <RouterForm spacing="md" method="post">
        <Stack gap={3}>
          <TextInput
            label={t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.callback.url")}
            name="callback_url"
            type="url"
            defaultValue={current?.callback_url ?? ""}
            placeholder="https://agent.example/hooks"
          />
          <Inline>
            <Button type="submit" name="intent" value="update-webhook">
              {t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.save")}
            </Button>
            {current ? (
              <Button type="submit" name="intent" value="disable-webhook" tone="danger">
                {t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.disable")}
              </Button>
            ) : null}
          </Inline>
        </Stack>
      </RouterForm>
      {current?.signing_secret_preview ? (
        <Stack gap={1}>
          <Text weight="semibold">{t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.secret.preview")}</Text>
          <Text tone="secondary">{current.signing_secret_preview}</Text>
        </Stack>
      ) : null}
      {current?.signing_secret ? (
        <Stack gap={1}>
          <Text weight="semibold">{t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.secret.once")}</Text>
          <EvidenceCodeBlock label={t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.secret.label")}>
            {current.signing_secret}
          </EvidenceCodeBlock>
          <CopyButton
            value={current.signing_secret}
            label={t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.secret.copy")}
            copiedLabel={t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook.secret.copied")}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}

export function AgentGrantDetailPage({
  grant,
  activity,
  webhook,
  savedWebhook,
  revocation,
  revocationAvailable = grant.status === "active",
  revocationActivated = false,
}: {
  grant: AgentGrant;
  activity: readonly AgentGrantActivityRecord[];
  webhook: AgentGrantWebhook | null;
  savedWebhook?: AgentGrantWebhook | null;
  revocation?: AgentGrantRevocationReceipt;
  revocationAvailable?: boolean;
  revocationActivated?: boolean;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [attemptId] = useState(() => {
    if (typeof window === "undefined") return globalThis.crypto.randomUUID();
    try {
      const retained = window.sessionStorage.getItem(`agent-grant-revocation:${grant.account_id ?? ""}:${grant.id}`);
      if (retained && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retained))
        return retained;
      const created = globalThis.crypto.randomUUID();
      window.sessionStorage.setItem(`agent-grant-revocation:${grant.account_id ?? ""}:${grant.id}`, created);
      return created;
    } catch {
      return globalThis.crypto.randomUUID();
    }
  });
  const revoking = navigation.formData?.get("intent") === "revoke";
  const state = revoking
    ? navigation.state === "submitting"
      ? "submitting"
      : "confirming"
    : (revocation?.state ??
      (revocationActivated && !revocationAvailable && grant.status === "revoked"
        ? "already-revoked-cleanup-complete"
        : "editing"));
  const stateMessage = {
    editing: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.editing"),
    submitting: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.submitting"),
    confirming: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.confirming"),
    succeeded: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.succeeded"),
    "already-revoked-cleanup-complete": t(
      "auth.features.agentGrants.ui.agentGrantDetailPage.revocation.already.complete",
    ),
    "failed-safe": t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.failed.safe"),
    conflict: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.conflict"),
    ambiguous: t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.ambiguous"),
    "reauth-required": t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.reauth"),
    "route-denied": t("auth.features.agentGrants.ui.agentGrantDetailPage.revocation.denied"),
  }[state];
  const name = clientLabel(grant);

  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents"), href: "/account/agents" },
        { label: name },
      ]}
      title={name}
      status={agentGrantStatusLabel(grant.status)}
      actions={
        revocationAvailable &&
        (grant.status === "active" ||
          (grant.status === "revoked" && !["succeeded", "already-revoked-cleanup-complete"].includes(state))) ? (
          <AlertDialog
            trigger={
              <Button
                type="button"
                tone="danger"
                disabled={revoking || ["conflict", "reauth-required", "route-denied"].includes(state)}
              >
                {t("auth.features.agentGrants.ui.agentGrantDetailPage.revoke")}
              </Button>
            }
            title={t("auth.features.agentGrants.ui.agentGrantDetailPage.revoke.confirm.title")}
            description={t("auth.features.agentGrants.ui.agentGrantDetailPage.revoke.confirm.description", {
              name,
            })}
            tone="danger"
            confirmLabel={t("auth.features.agentGrants.ui.agentGrantDetailPage.revoke")}
            cancelLabel={t("auth.features.agentGrants.ui.agentGrantDetailPage.cancel")}
            onConfirm={() =>
              submit({ intent: "revoke", attempt_id: revocation?.attempt_id ?? attemptId }, { method: "post" })
            }
          />
        ) : null
      }
      sections={[
        ...(revocationActivated
          ? [
              {
                label: t("auth.features.agentGrants.ui.agentGrantDetailPage.revoke"),
                value: <Text role="status">{stateMessage}</Text>,
              },
            ]
          : []),
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.agent"),
          value: (
            <Stack gap={0}>
              <Text tone="secondary">{grant.platform_profile_url}</Text>
              <Text tone="secondary">
                {t("auth.features.agentGrants.ui.agentGrantDetailPage.connected.on", {
                  date: formatDateTime(grant.granted_at, {
                    preset: "short",
                    fallback: authDateUnavailable(),
                  }),
                })}
              </Text>
              <Badge tone={agentGrantStatusTone(grant.status)}>{agentGrantStatusLabel(grant.status)}</Badge>
            </Stack>
          ),
        },
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.scopes"),
          value: <GrantedScopes scopes={grant.scopes} />,
        },
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.spend"),
          value: <SpendSummary grant={grant} />,
        },
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.mandate"),
          value: <MandateForm grant={grant} />,
        },
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.webhook"),
          value: <WebhookForm webhook={webhook} savedWebhook={savedWebhook} />,
        },
        {
          label: t("auth.features.agentGrants.ui.agentGrantDetailPage.activity"),
          value: <ActivityTable activity={activity} />,
        },
      ]}
    />
  );
}
