import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  Grid,
  Inline,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  Banner,
  type DataColumn,
  type Tone,
} from "@chase-sets/design-system";
import type { WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../read-model/queries";
import type { SettlementWalletAdjustmentRow } from "../read-model/wallet-adjustment-queries";
import type { SettlementWalletAdjustmentPreview } from "../../../client";
import type { WalletAdjustmentFlowError } from "../../../support/request-support/wallet-adjustment-flow-error";
import type { WalletAdjustmentGuidedFlowValues } from "../../../support/request-support/wallet-adjustment-guided-flow-form-data";
import { WalletAdjustmentGuidedFlowForm } from "./wallet-adjustment-guided-flow";
import { WalletAdjustmentApprovalActions } from "./wallet-adjustment-approval-actions";
import { WalletAdjustmentReversalActions } from "./wallet-adjustment-reversal-actions";

export const WALLET_ADJUSTMENT_PERMISSIONS = {
  view: "wallet-adjustments.view",
  create: "wallet-adjustments.create",
  approve: "wallet-adjustments.approve",
  reverse: "wallet-adjustments.reverse",
} as const;

export type WalletWorkbenchStatus = "ok" | "permission-denied" | "not-found" | "unavailable";

export type WalletWorkbenchAdjustmentsFilters = Readonly<{
  status?: SettlementWalletAdjustmentRow["status"];
  limit: number;
  offset: number;
}>;

export type WalletWorkbenchLedgerFilters = Readonly<{
  limit: number;
  offset: number;
}>;

export type WalletWorkbenchLastAction = Readonly<{
  intent: string;
  adjustmentId?: string | null;
  snapshot?: SettlementWalletAdjustmentRow | null;
  reversal?: SettlementWalletAdjustmentRow | null;
  preview?: SettlementWalletAdjustmentPreview | null;
  values?: WalletAdjustmentGuidedFlowValues | null;
  error?: WalletAdjustmentFlowError | null;
}>;

export interface SettlementWalletWorkbenchPageProps {
  accountId: string;
  accountLabel?: string | null;
  status: WalletWorkbenchStatus;
  wallet?: SettlementWalletRow | null;
  adjustments: { items: readonly SettlementWalletAdjustmentRow[]; total: number };
  adjustmentsFilters: WalletWorkbenchAdjustmentsFilters;
  ledger: { items: readonly SettlementLedgerEntryRow[]; total: number };
  ledgerFilters: WalletWorkbenchLedgerFilters;
  actorPermissions: readonly string[];
  currentActorUserId?: string;
  lastAction?: WalletWorkbenchLastAction | null;
  marketplaceOrigin?: string | null;
}

function hasPermission(actorPermissions: readonly string[], permission: string) {
  return actorPermissions.includes(permission);
}

function negativeBalanceTone(status: SettlementWalletRow["negative_balance_status"]): Tone {
  if (status === "collections") {
    return "danger";
  }
  if (status === "negative") {
    return "warning";
  }
  return "success";
}

function negativeBalanceLabel(status: SettlementWalletRow["negative_balance_status"]) {
  if (status === "collections") {
    return t("settlement.features.wallets.ui.walletWorkbenchPage.standing.collections");
  }
  if (status === "negative") {
    return t("settlement.features.wallets.ui.walletWorkbenchPage.standing.negative");
  }
  return t("settlement.features.wallets.ui.walletWorkbenchPage.standing.good");
}

function adjustmentStatusTone(status: SettlementWalletAdjustmentRow["status"]): Tone {
  switch (status) {
    case "posted":
      return "success";
    case "reversed":
      return "neutral";
    case "rejected":
      return "danger";
    case "approved":
      return "accent";
    case "requested":
    default:
      return "warning";
  }
}

function adjustmentStatusLabel(status: SettlementWalletAdjustmentRow["status"]) {
  switch (status) {
    case "requested":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.status.requested");
    case "approved":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.status.approved");
    case "rejected":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.status.rejected");
    case "posted":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.status.posted");
    case "reversed":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.status.reversed");
    default:
      return status;
  }
}

function reasonCodeLabel(code: WalletAdjustmentReasonCode | string) {
  switch (code) {
    case "transaction-correction":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.transaction.correction");
    case "refund-correction":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.refund.correction");
    case "fee-correction":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.fee.correction");
    case "dispute-resolution":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.dispute.resolution");
    case "fraud-recovery":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.fraud.recovery");
    case "support-resolution":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.support.resolution");
    case "legal-obligation":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.legal.obligation");
    case "goodwill-cash-credit":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.goodwill.cash.credit");
    case "operational-error":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.operational.error");
    case "other-with-required-detail":
      return t("settlement.features.wallets.ui.walletWorkbenchPage.reason.other.with.required.detail");
    default:
      return code;
  }
}

function payoutDetailHref(payoutId: string, marketplaceOrigin?: string | null) {
  if (!marketplaceOrigin) {
    return null;
  }
  return new URL(`/account/payouts/${payoutId}`, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

function AccountBalanceSummary({ wallet }: { wallet: SettlementWalletRow }) {
  const restricted = wallet.negative_balance_status !== "in-good-standing";

  return (
    <PageSection title={t("settlement.features.wallets.ui.walletWorkbenchPage.balance")}>
      <Grid columns={{ base: 1, md: 2, lg: 4 }} gap={3}>
        <Card>
          <Stack gap={1}>
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.available")}
            </Text>
            <Text size="lg">{formatMoney(wallet.available_balance_amount, wallet.currency_code)}</Text>
          </Stack>
        </Card>
        <Card>
          <Stack gap={1}>
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.pending")}
            </Text>
            <Text size="lg">{formatMoney(wallet.pending_balance_amount, wallet.currency_code)}</Text>
          </Stack>
        </Card>
        <Card>
          <Stack gap={1}>
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.lifetime.credits")}
            </Text>
            <Text size="lg">{formatMoney(wallet.total_credited_amount, wallet.currency_code)}</Text>
          </Stack>
        </Card>
        <Card>
          <Stack gap={1}>
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.lifetime.debits")}
            </Text>
            <Text size="lg">{formatMoney(wallet.total_debited_amount, wallet.currency_code)}</Text>
          </Stack>
        </Card>
      </Grid>
      <Inline gap={2} align="center">
        <Badge tone={negativeBalanceTone(wallet.negative_balance_status)}>
          {negativeBalanceLabel(wallet.negative_balance_status)}
        </Badge>
        <Text size="sm" tone="secondary">
          {wallet.updated_at
            ? t("settlement.features.wallets.ui.walletWorkbenchPage.last.updated", {
                date: formatDateTime(wallet.updated_at),
              })
            : t("settlement.features.wallets.ui.walletWorkbenchPage.never.updated")}
        </Text>
      </Inline>
      {restricted ? (
        <Banner
          tone={wallet.negative_balance_status === "collections" ? "danger" : "warning"}
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.payout.restricted.title")}
          description={
            wallet.negative_balance_status === "collections"
              ? t("settlement.features.wallets.ui.walletWorkbenchPage.payout.restricted.collections.description")
              : t("settlement.features.wallets.ui.walletWorkbenchPage.payout.restricted.negative.description")
          }
        />
      ) : null}
    </PageSection>
  );
}

function CreateAdjustmentForm({
  accountId,
  accountLabel,
  currencyCode,
  lastAction,
}: {
  accountId: string;
  accountLabel: string;
  currencyCode: string;
  lastAction?: WalletWorkbenchLastAction | null;
}) {
  const preview = lastAction?.intent === "preview-adjustment" ? (lastAction.preview ?? null) : null;
  const flowError =
    lastAction?.intent === "preview-adjustment" || lastAction?.intent === "request-adjustment"
      ? (lastAction.error ?? null)
      : null;

  return (
    <PageSection title={t("settlement.features.wallets.ui.walletWorkbenchPage.request.adjustment")}>
      <WalletAdjustmentGuidedFlowForm
        targetAccountId={accountId}
        targetAccountLabel={accountLabel}
        currencyCode={currencyCode}
        preview={preview}
        flowError={flowError}
        {...(lastAction?.values ? { defaultValues: lastAction.values } : {})}
      />
    </PageSection>
  );
}

function AdjustmentActionsCell({
  adjustment,
  accountLabel,
  actorPermissions,
  currentActorUserId,
  lastAction,
}: {
  adjustment: SettlementWalletAdjustmentRow;
  accountLabel: string;
  actorPermissions: readonly string[];
  currentActorUserId: string;
  lastAction?: WalletWorkbenchLastAction | null;
}) {
  const canApprove = hasPermission(actorPermissions, WALLET_ADJUSTMENT_PERMISSIONS.approve);
  const canReverse = hasPermission(actorPermissions, WALLET_ADJUSTMENT_PERMISSIONS.reverse);
  const scopedError =
    (lastAction?.intent === "approve-adjustment" ||
      lastAction?.intent === "reject-adjustment" ||
      lastAction?.intent === "reverse-adjustment") &&
    lastAction.adjustmentId === adjustment.adjustment_id
      ? (lastAction.error ?? null)
      : null;

  if (adjustment.status === "requested" && canApprove) {
    return (
      <WalletAdjustmentApprovalActions
        adjustment={adjustment}
        targetAccountLabel={accountLabel}
        currentActorUserId={currentActorUserId}
        flowError={scopedError}
      />
    );
  }
  if (adjustment.status === "posted" && canReverse) {
    return (
      <WalletAdjustmentReversalActions
        adjustment={adjustment}
        targetAccountLabel={accountLabel}
        flowError={scopedError}
      />
    );
  }
  return null;
}

const adjustmentStatusFilterValues = ["all", "requested", "approved", "rejected", "posted", "reversed"] as const;

function adjustmentStatusFilterLabel(value: (typeof adjustmentStatusFilterValues)[number]) {
  if (value === "all") {
    return t("settlement.features.wallets.ui.walletWorkbenchPage.filter.all");
  }
  return adjustmentStatusLabel(value);
}

function AdjustmentHistorySection({
  accountId,
  accountLabel,
  adjustments,
  filters,
  actorPermissions,
  currentActorUserId,
  lastAction,
}: {
  accountId: string;
  accountLabel: string;
  adjustments: { items: readonly SettlementWalletAdjustmentRow[]; total: number };
  filters: WalletWorkbenchAdjustmentsFilters;
  actorPermissions: readonly string[];
  currentActorUserId: string;
  lastAction?: WalletWorkbenchLastAction | null;
}) {
  const currentStatus = filters.status ?? "all";
  const knownIds = new Set(adjustments.items.map((item) => item.adjustment_id));
  const staleSnapshots = [lastAction?.snapshot, lastAction?.reversal].filter(
    (snapshot): snapshot is SettlementWalletAdjustmentRow =>
      Boolean(snapshot) && !knownIds.has(snapshot!.adjustment_id),
  );
  const displayedItems = [...staleSnapshots, ...adjustments.items];

  const columns: DataColumn<SettlementWalletAdjustmentRow>[] = [
    {
      key: "status",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.status"),
      cell: (row) => (
        <Stack gap={1}>
          <Badge tone={adjustmentStatusTone(row.status)}>{adjustmentStatusLabel(row.status)}</Badge>
          <Text size="sm" tone="secondary">
            {row.adjustment_id}
          </Text>
        </Stack>
      ),
    },
    {
      key: "direction",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.direction"),
      cell: (row) => (
        <Stack gap={1}>
          <Badge tone={row.direction === "credit" ? "success" : "danger"}>{row.direction}</Badge>
          <Text weight="semibold">{formatMoney(row.amount, row.currency_code)}</Text>
        </Stack>
      ),
    },
    {
      key: "reason",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.reason"),
      cell: (row) => (
        <Stack gap={1}>
          <Text>{reasonCodeLabel(row.reason_code)}</Text>
          {row.explanation ? (
            <Text size="sm" tone="secondary">
              {row.explanation}
            </Text>
          ) : null}
          {row.evidence_references.length > 0 ? (
            <Text size="sm" tone="secondary">
              {row.evidence_references.join(", ")}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "actors",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.actors"),
      cell: (row) => (
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletWorkbenchPage.requested.by", { userId: row.requested_by })}
          </Text>
          {row.approved_by ? (
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.approved.by", { userId: row.approved_by })}
            </Text>
          ) : null}
          {row.rejected_by ? (
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.rejected.by", { userId: row.rejected_by })}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "resulting-balance",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.resulting.balance"),
      cell: (row) => (row.available_balance_after ? formatMoney(row.available_balance_after, row.currency_code) : "—"),
    },
    {
      key: "reversal",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.reversal"),
      cell: (row) =>
        row.reversal_of_adjustment_id ? (
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletWorkbenchPage.reverses", { id: row.reversal_of_adjustment_id })}
          </Text>
        ) : row.reversed_by_adjustment_id ? (
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletWorkbenchPage.reversed.by", { id: row.reversed_by_adjustment_id })}
          </Text>
        ) : (
          "—"
        ),
    },
    {
      key: "timestamps",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.timeline"),
      cell: (row) => (
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {formatDateTime(row.requested_at)}
          </Text>
          {row.posted_at ? (
            <Text size="sm" tone="secondary">
              {t("settlement.features.wallets.ui.walletWorkbenchPage.posted.at", {
                date: formatDateTime(row.posted_at),
              })}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "actions",
      header: t("settlement.features.wallets.ui.walletWorkbenchPage.actions"),
      cell: (row) => (
        <AdjustmentActionsCell
          adjustment={row}
          accountLabel={accountLabel}
          actorPermissions={actorPermissions}
          currentActorUserId={currentActorUserId}
          lastAction={lastAction}
        />
      ),
    },
  ];

  const showPager = adjustments.total > filters.limit || filters.offset > 0;

  return (
    <PageSection title={t("settlement.features.wallets.ui.walletWorkbenchPage.adjustment.history")}>
      {staleSnapshots.length > 0 ? (
        <Banner
          tone="info"
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.projection.catching.up.title")}
          description={t("settlement.features.wallets.ui.walletWorkbenchPage.projection.catching.up.description")}
        />
      ) : null}
      <Inline gap={2}>
        {adjustmentStatusFilterValues.map((value) => (
          <LinkButton
            key={value}
            href={
              value === "all"
                ? `/commerce/wallet-workbench/${accountId}`
                : `/commerce/wallet-workbench/${accountId}?status=${value}`
            }
            tone={currentStatus === value ? "primary" : "secondary"}
            size="sm"
          >
            {adjustmentStatusFilterLabel(value)}
          </LinkButton>
        ))}
      </Inline>
      <DataTable
        rows={[...displayedItems]}
        getRowId={(row) => row.adjustment_id}
        columns={columns}
        emptyTitle={t("settlement.features.wallets.ui.walletWorkbenchPage.no.adjustments.title")}
        emptyDescription={t("settlement.features.wallets.ui.walletWorkbenchPage.no.adjustments.description")}
      />
      {showPager ? (
        <Inline gap={2}>
          {filters.offset > 0 ? (
            <LinkButton
              href={`/commerce/wallet-workbench/${accountId}?${new URLSearchParams({
                ...(currentStatus !== "all" ? { status: currentStatus } : {}),
                adjustmentsOffset: String(Math.max(0, filters.offset - filters.limit)),
              }).toString()}`}
              tone="secondary"
              size="sm"
            >
              {t("settlement.features.wallets.ui.walletWorkbenchPage.previous")}
            </LinkButton>
          ) : null}
          {filters.offset + filters.limit < adjustments.total ? (
            <LinkButton
              href={`/commerce/wallet-workbench/${accountId}?${new URLSearchParams({
                ...(currentStatus !== "all" ? { status: currentStatus } : {}),
                adjustmentsOffset: String(filters.offset + filters.limit),
              }).toString()}`}
              tone="secondary"
              size="sm"
            >
              {t("settlement.features.wallets.ui.walletWorkbenchPage.next")}
            </LinkButton>
          ) : null}
        </Inline>
      ) : null}
    </PageSection>
  );
}

function LedgerSection({
  accountId,
  ledger,
  filters,
  marketplaceOrigin,
}: {
  accountId: string;
  ledger: { items: readonly SettlementLedgerEntryRow[]; total: number };
  filters: WalletWorkbenchLedgerFilters;
  marketplaceOrigin?: string | null;
}) {
  const showPager = ledger.total > filters.limit || filters.offset > 0;

  return (
    <PageSection title={t("settlement.features.wallets.ui.walletWorkbenchPage.ledger")}>
      <DataTable
        rows={[...ledger.items]}
        getRowId={(row) => row.ledger_entry_id}
        columns={[
          {
            key: "kind",
            header: t("settlement.features.wallets.ui.walletWorkbenchPage.kind"),
            cell: (row) => (
              <Stack gap={1}>
                <Text weight="semibold">{row.kind}</Text>
                {row.description ? (
                  <Text size="sm" tone="secondary">
                    {row.description}
                  </Text>
                ) : null}
              </Stack>
            ),
          },
          {
            key: "direction",
            header: t("settlement.features.wallets.ui.walletWorkbenchPage.direction"),
            cell: (row) => <Badge tone={row.direction === "credit" ? "success" : "danger"}>{row.direction}</Badge>,
          },
          {
            key: "amount",
            header: t("settlement.features.wallets.ui.walletWorkbenchPage.amount"),
            align: "right",
            cell: (row) => formatMoney(row.amount, row.currency_code),
          },
          {
            key: "posted_at",
            header: t("settlement.features.wallets.ui.walletWorkbenchPage.posted"),
            cell: (row) => formatDateTime(row.posted_at),
          },
          {
            key: "related",
            header: t("settlement.features.wallets.ui.walletWorkbenchPage.related"),
            cell: (row) => {
              const href = row.payout_id ? payoutDetailHref(row.payout_id, marketplaceOrigin) : null;
              return href ? (
                <LinkButton href={href} target="_blank" rel="noreferrer" tone="secondary" size="sm">
                  {t("settlement.features.wallets.ui.walletWorkbenchPage.related.payout")}
                </LinkButton>
              ) : row.order_id ? (
                <Text size="sm" tone="secondary">
                  {row.order_id}
                </Text>
              ) : (
                "—"
              );
            },
          },
        ]}
        emptyTitle={t("settlement.features.wallets.ui.walletWorkbenchPage.no.ledger.title")}
        emptyDescription={t("settlement.features.wallets.ui.walletWorkbenchPage.no.ledger.description")}
      />
      {showPager ? (
        <Inline gap={2}>
          {filters.offset > 0 ? (
            <LinkButton
              href={`/commerce/wallet-workbench/${accountId}?ledgerOffset=${Math.max(0, filters.offset - filters.limit)}`}
              tone="secondary"
              size="sm"
            >
              {t("settlement.features.wallets.ui.walletWorkbenchPage.previous")}
            </LinkButton>
          ) : null}
          {filters.offset + filters.limit < ledger.total ? (
            <LinkButton
              href={`/commerce/wallet-workbench/${accountId}?ledgerOffset=${filters.offset + filters.limit}`}
              tone="secondary"
              size="sm"
            >
              {t("settlement.features.wallets.ui.walletWorkbenchPage.next")}
            </LinkButton>
          ) : null}
        </Inline>
      ) : null}
    </PageSection>
  );
}

export function SettlementWalletWorkbenchPage(props: SettlementWalletWorkbenchPageProps) {
  const { accountId, accountLabel, status, actorPermissions } = props;

  if (status === "not-found") {
    return (
      <Page>
        <PageHeader
          eyebrow={t("settlement.features.wallets.ui.walletWorkbenchPage.settlement")}
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.wallet.workbench")}
        />
        <EmptyState
          icon="search"
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.account.not.found.title")}
          description={t("settlement.features.wallets.ui.walletWorkbenchPage.account.not.found.description", {
            accountId,
          })}
        />
      </Page>
    );
  }

  if (status === "permission-denied") {
    return (
      <Page>
        <PageHeader
          eyebrow={t("settlement.features.wallets.ui.walletWorkbenchPage.settlement")}
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.wallet.workbench")}
        />
        <EmptyState
          icon="lock"
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.permission.denied.title")}
          description={t("settlement.features.wallets.ui.walletWorkbenchPage.permission.denied.description")}
        />
      </Page>
    );
  }

  if (status === "unavailable") {
    return (
      <Page>
        <PageHeader
          eyebrow={t("settlement.features.wallets.ui.walletWorkbenchPage.settlement")}
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.wallet.workbench")}
        />
        <EmptyState
          icon="xCircle"
          title={t("settlement.features.wallets.ui.walletWorkbenchPage.unavailable.title")}
          description={t("settlement.features.wallets.ui.walletWorkbenchPage.unavailable.description")}
        />
      </Page>
    );
  }

  const wallet = props.wallet ?? null;
  const canCreate = hasPermission(actorPermissions, WALLET_ADJUSTMENT_PERMISSIONS.create);
  const resolvedAccountLabel = accountLabel || accountId;
  const currentActorUserId = props.currentActorUserId ?? "";

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.wallets.ui.walletWorkbenchPage.settlement")}
        title={
          accountLabel
            ? t("settlement.features.wallets.ui.walletWorkbenchPage.wallet.for.account", { name: accountLabel })
            : t("settlement.features.wallets.ui.walletWorkbenchPage.wallet.workbench")
        }
        description={t("settlement.features.wallets.ui.walletWorkbenchPage.account.id.reference", { accountId })}
      />
      {wallet ? <AccountBalanceSummary wallet={wallet} /> : null}
      {canCreate && wallet ? (
        <CreateAdjustmentForm
          accountId={accountId}
          accountLabel={resolvedAccountLabel}
          currencyCode={wallet.currency_code}
          lastAction={props.lastAction}
        />
      ) : null}
      <AdjustmentHistorySection
        accountId={accountId}
        accountLabel={resolvedAccountLabel}
        adjustments={props.adjustments}
        filters={props.adjustmentsFilters}
        actorPermissions={actorPermissions}
        currentActorUserId={currentActorUserId}
        lastAction={props.lastAction}
      />
      <LedgerSection
        accountId={accountId}
        ledger={props.ledger}
        filters={props.ledgerFilters}
        marketplaceOrigin={props.marketplaceOrigin}
      />
    </Page>
  );
}
