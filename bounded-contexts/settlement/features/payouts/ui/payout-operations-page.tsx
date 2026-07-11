import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementPayoutRow, SettlementProviderIdempotencyKeyRow } from "../read-model/queries";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";

function formatMoney(amount: string, currencyCode: string) {
  return `${amount} ${currencyCode.toUpperCase()}`;
}

function operationsTone(row: SettlementPayoutRow): Tone {
  if (row.status === "failed") {
    return "danger";
  }
  if (!row.provider_payout_reference) {
    return "warning";
  }
  return "accent";
}

function operationsLabel(row: SettlementPayoutRow) {
  if (row.status === "failed" && row.next_retry_at) {
    return t("settlement.features.payouts.ui.payoutOperationsPage.retry.queued");
  }
  if (!row.provider_payout_reference) {
    return t("settlement.features.payouts.ui.payoutOperationsPage.needs.provider.reference");
  }
  if (row.status === "in-transit") {
    return t("settlement.features.payouts.ui.payoutOperationsPage.ready.to.reconcile");
  }
  return t("settlement.features.payouts.ui.payoutOperationsPage.review");
}

function payoutConfirmationLabel(row: SettlementPayoutRow) {
  return row.provider_payout_reference
    ? t("settlement.features.payouts.ui.payoutOperationsPage.confirmed")
    : t("settlement.features.payouts.ui.payoutOperationsPage.pending.confirmation");
}

function payoutReadinessIsStale(updatedAt: string | null) {
  if (!updatedAt) {
    return false;
  }
  return Date.now() - Date.parse(updatedAt) > 30 * 24 * 60 * 60 * 1000;
}

function payoutDetailHref(payoutId: string, marketplaceOrigin?: string | null) {
  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(`/account/payouts/${payoutId}`, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

export function SettlementPayoutOperationsPage({
  payouts,
  idempotencyKeys = [],
  payoutReadiness,
  runResult,
  currentFilter = "all",
  lastCheckedAt,
  marketplaceOrigin,
}: {
  payouts: readonly SettlementPayoutRow[];
  idempotencyKeys?: readonly SettlementProviderIdempotencyKeyRow[];
  payoutReadiness?: SettlementPayoutReadinessRow | null;
  runResult?: Readonly<{
    jobId: string;
    status: string;
    progress: Readonly<{
      phase: string;
      completed: number;
      total: number;
      message: string | null;
    }>;
    result: Readonly<{
      checked: number;
      reconciled: number;
      ignored: number;
      skipped: number;
      errors: readonly Readonly<{ payoutId: string; message: string }>[];
    }> | null;
    errorMessage?: string | null;
  }> | null;
  currentFilter?: string;
  lastCheckedAt?: string | null;
  marketplaceOrigin?: string | null;
}) {
  const filters = [
    ["all", t("settlement.features.payouts.ui.payoutOperationsPage.all")],
    ["missing-provider-reference", t("settlement.features.payouts.ui.payoutOperationsPage.missing.reference")],
    ["in-transit", t("settlement.features.payouts.ui.payoutOperationsPage.in.transit")],
    ["failed", t("settlement.features.payouts.ui.payoutOperationsPage.failed")],
    ["stale-requested", t("settlement.features.payouts.ui.payoutOperationsPage.older.than.15.minutes")],
  ] as const;
  const failedCount = payouts.filter((payout) => payout.status === "failed").length;
  const missingReferenceCount = payouts.filter((payout) => !payout.provider_payout_reference).length;
  const retryQueuedCount = payouts.filter((payout) => Boolean(payout.next_retry_at)).length;
  const staleCheckCount = payouts.filter((payout) => {
    if (!payout.last_reconciled_at) {
      return payout.status !== "requested";
    }
    return Date.now() - new Date(payout.last_reconciled_at).getTime() > 30 * 60 * 1000;
  }).length;
  const payoutSetupBlocked = payoutReadiness
    ? payoutReadiness.status !== "ready" || !payoutReadiness.provider_reference
    : false;
  const payoutSetupStale = payoutReadiness ? payoutReadinessIsStale(payoutReadiness.updated_at) : false;
  const payoutSetupMissingRequirementCount = payoutReadiness?.missing_requirements.length ?? 0;
  const terminalRunResult = runResult?.result ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.payouts.ui.payoutOperationsPage.settlement")}
        title={t("settlement.features.payouts.ui.payoutOperationsPage.payout.operations")}
        description={t("settlement.features.payouts.ui.payoutOperationsPage.monitor.payouts.that.may.need.provider")}
        actions={
          <LinkButton href="/commerce/money-health" tone="secondary">
            {t("settlement.features.payouts.ui.payoutOperationsPage.money.health")}
          </LinkButton>
        }
      />

      <PageSection title={t("settlement.features.payouts.ui.payoutOperationsPage.reconciliation")}>
        <Card>
          <Stack gap={3}>
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="run-reconciliation" />
              <Button type="submit">
                {t("settlement.features.payouts.ui.payoutOperationsPage.run.reconciliation")}
              </Button>
            </Form>
            <Text size="sm" tone="secondary">
              {t("settlement.features.payouts.ui.payoutOperationsPage.last.checked")}
              {lastCheckedAt
                ? new Date(lastCheckedAt).toLocaleString()
                : t("settlement.features.payouts.ui.payoutOperationsPage.not.checked.in.this.session")}
            </Text>
            {runResult ? (
              <Stack gap={1}>
                <Badge
                  tone={
                    runResult.status === "failed" ? "danger" : runResult.status === "completed" ? "success" : "accent"
                  }
                >
                  {runResult.status}
                </Badge>
                {runResult.progress.message ? (
                  <Text size="sm" tone="secondary">
                    {runResult.progress.message}
                  </Text>
                ) : null}
                <Text size="sm" tone="secondary">
                  {t("settlement.features.payouts.ui.payoutOperationsPage.checked")}
                  {terminalRunResult?.checked ?? runResult.progress.completed}
                  {t("settlement.features.payouts.ui.payoutOperationsPage.reconciled")}
                  {terminalRunResult?.reconciled ?? 0}
                  {t("settlement.features.payouts.ui.payoutOperationsPage.ignored")}
                  {terminalRunResult?.ignored ?? 0}
                  {t("settlement.features.payouts.ui.payoutOperationsPage.skipped")}
                  {terminalRunResult?.skipped ?? 0}.
                </Text>
                {terminalRunResult && terminalRunResult.errors.length > 0 ? (
                  <Text size="sm" tone="secondary">
                    {t("settlement.features.payouts.ui.payoutOperationsPage.errors")}
                    {terminalRunResult.errors.map((error) => error.message).join("; ")}
                  </Text>
                ) : null}
                {runResult.errorMessage ? (
                  <Text size="sm" tone="secondary">
                    {t("settlement.features.payouts.ui.payoutOperationsPage.errors")}
                    {runResult.errorMessage}
                  </Text>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.payoutOperationsPage.needs.attention")}>
        <DataTable
          rows={[
            {
              id: "failed",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.failed.payouts"),
              value: failedCount,
              detail: t(
                "settlement.features.payouts.ui.payoutOperationsPage.provider.reported.failure.or.internal.submission",
              ),
            },
            {
              id: "missing-reference",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.missing.provider.references"),
              value: missingReferenceCount,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.transfer.or.payout.reference.has.not"),
            },
            {
              id: "retry-queued",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.retry.queued.2"),
              value: retryQueuedCount,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.retry.policy.has.a.next.provider"),
            },
            {
              id: "stale-checks",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.stale.reconciliation"),
              value: staleCheckCount,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.provider.status.has.not.been.checked"),
            },
            {
              id: "payout-setup-blocked",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.payout.setup.blocked"),
              value: payoutSetupBlocked ? 1 : 0,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.account.cannot.request.payouts.until"),
            },
            {
              id: "payout-setup-requirements",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.open.setup.requirements"),
              value: payoutSetupMissingRequirementCount,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.provider.requirement.groups.remain.open"),
            },
            {
              id: "payout-setup-stale",
              label: t("settlement.features.payouts.ui.payoutOperationsPage.stale.payout.setup.status"),
              value: payoutSetupStale ? 1 : 0,
              detail: t("settlement.features.payouts.ui.payoutOperationsPage.payout.setup.status.needs.refresh"),
            },
          ]}
          getRowId={(row) => row.id}
          columns={[
            {
              key: "label",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.signal"),
              cell: (row) => row.label,
            },
            {
              key: "value",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.count"),
              cell: (row) => <Badge tone={row.value > 0 ? "warning" : "success"}>{row.value}</Badge>,
            },
            {
              key: "detail",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.meaning"),
              cell: (row) => row.detail,
            },
          ]}
        />
        {payoutReadiness ? (
          <DataTable
            rows={[
              {
                id: "setup-status",
                label: t("settlement.features.payouts.ui.payoutOperationsPage.setup.status"),
                value: payoutReadiness.status,
                detail: t("settlement.features.payouts.ui.payoutOperationsPage.current.payout.setup.status"),
              },
              {
                id: "destination",
                label: t("settlement.features.payouts.ui.payoutOperationsPage.payout.destination"),
                value: payoutReadiness.payout_destination_status,
                detail: t("settlement.features.payouts.ui.payoutOperationsPage.destination.status.from.provider"),
              },
              {
                id: "last-updated",
                label: t("settlement.features.payouts.ui.payoutOperationsPage.setup.last.updated"),
                value: payoutReadiness.updated_at
                  ? new Date(payoutReadiness.updated_at).toLocaleString()
                  : t("settlement.features.payouts.ui.payoutOperationsPage.not.checked"),
                detail: t("settlement.features.payouts.ui.payoutOperationsPage.provider.readiness.snapshot"),
              },
            ]}
            getRowId={(row) => row.id}
            columns={[
              {
                key: "label",
                header: t("settlement.features.payouts.ui.payoutOperationsPage.signal"),
                cell: (row) => row.label,
              },
              {
                key: "value",
                header: t("settlement.features.payouts.ui.payoutOperationsPage.status"),
                cell: (row) => (
                  <Badge tone={payoutSetupBlocked || payoutSetupStale ? "warning" : "success"}>{row.value}</Badge>
                ),
              },
              {
                key: "detail",
                header: t("settlement.features.payouts.ui.payoutOperationsPage.meaning"),
                cell: (row) => row.detail,
              },
            ]}
          />
        ) : null}
        <Stack direction="row" gap={2}>
          {filters.map(([value, label]) => (
            <LinkButton
              key={value}
              href={value === "all" ? "/commerce/payout-operations" : `/commerce/payout-operations?filter=${value}`}
              tone={currentFilter === value ? "primary" : "secondary"}
              size="sm"
            >
              {label}
            </LinkButton>
          ))}
        </Stack>
        <DataTable
          rows={[...payouts]}
          getRowId={(row) => row.payout_id}
          columns={[
            {
              key: "status",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.status"),
              cell: (row) => <Badge tone={operationsTone(row)}>{operationsLabel(row)}</Badge>,
            },
            {
              key: "amount",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.amount"),
              cell: (row) => formatMoney(row.amount, row.currency_code),
            },
            {
              key: "provider_payout_reference",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.payout.confirmation"),
              cell: (row) => payoutConfirmationLabel(row),
            },
            {
              key: "provider_status",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.external.status"),
              cell: (row) => row.provider_status ?? t("settlement.features.payouts.ui.payoutOperationsPage.unknown"),
            },
            {
              key: "last_reconciled_at",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.last.checked.2"),
              cell: (row) =>
                row.last_reconciled_at
                  ? new Date(row.last_reconciled_at).toLocaleString()
                  : t("settlement.features.payouts.ui.payoutOperationsPage.not.checked"),
            },
            {
              key: "retry",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.retry.policy"),
              cell: (row) =>
                row.next_retry_at
                  ? `${row.retry_count} attempt${row.retry_count === 1 ? "" : "s"}; next ${new Date(row.next_retry_at).toLocaleString()}`
                  : row.retry_count > 0
                    ? `${row.retry_count} attempt${row.retry_count === 1 ? "" : "s"}`
                    : t("settlement.features.payouts.ui.payoutOperationsPage.none"),
            },
            {
              key: "updated_at",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.updated"),
              cell: (row) => new Date(row.updated_at).toLocaleString(),
            },
            {
              key: "actions",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.actions"),
              cell: (row) => {
                const href = payoutDetailHref(row.payout_id, marketplaceOrigin);
                return href ? (
                  <LinkButton
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    trailingIcon="externalLink"
                    tone="secondary"
                    size="sm"
                  >
                    {t("settlement.features.payouts.ui.payoutOperationsPage.open")}
                  </LinkButton>
                ) : null;
              },
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.payoutOperationsPage.no.payouts.need.attention")}
          emptyDescription={t(
            "settlement.features.payouts.ui.payoutOperationsPage.provider.payout.reconciliation.is.clear",
          )}
        />
      </PageSection>

      <PageSection title={t("settlement.features.payouts.ui.payoutOperationsPage.recent.provider.attempts")}>
        <DataTable
          rows={[...idempotencyKeys]}
          getRowId={(row) => row.operation_key}
          columns={[
            {
              key: "operation",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.operation"),
              cell: (row) => row.operation_kind,
            },
            {
              key: "payout",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.payout"),
              cell: (row) => row.payout_id ?? t("settlement.features.payouts.ui.payoutOperationsPage.none"),
            },
            {
              key: "provider",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.provider.reference"),
              cell: (row) =>
                row.provider_object_reference ?? t("settlement.features.payouts.ui.payoutOperationsPage.pending"),
            },
            {
              key: "idempotency",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.idempotency.key"),
              cell: () => t("settlement.features.payouts.ui.payoutOperationsPage.protected.retry.key"),
            },
            {
              key: "created",
              header: t("settlement.features.payouts.ui.payoutOperationsPage.created"),
              cell: (row) => new Date(row.created_at).toLocaleString(),
            },
          ]}
          emptyTitle={t("settlement.features.payouts.ui.payoutOperationsPage.no.provider.attempts")}
          emptyDescription={t(
            "settlement.features.payouts.ui.payoutOperationsPage.provider.transfer.and.payout.submissions.appear",
          )}
        />
      </PageSection>
    </Page>
  );
}
