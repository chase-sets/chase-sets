import { useState } from "react";
import { formatDateTime, t } from "@chase-sets/localization";
import {
  AlertDialog,
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Switch,
} from "@chase-sets/design-system";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingHaltState } from "../domain/halt";
import type { RepricingPolicyState } from "../domain/domain";
import { formatRepricingCount, repricingBudgetLabel, repricingScopeLabel, repricingStatusBadge } from "./policy-copy";

export type { RepricingHaltState };

export type RepricingPolicyListRow = RepricingPolicyState & Readonly<{ changesUsedToday: number }>;

export function repricingPolicyHref(policyId: string): string {
  return `/account/desk/repricing/${encodeURIComponent(policyId)}`;
}

// The account-wide halt: a warning banner while engaged, and a switch whose
// every flip — engage or release — goes through a confirmation first.
export function RepricingHaltControl({
  halt,
  disabled = false,
  onHaltChange,
}: {
  halt: RepricingHaltState;
  disabled?: boolean;
  onHaltChange: (engaged: boolean) => void;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const engaging = pending === true;

  return (
    <Stack gap={3} data-testid="repricing-halt">
      <Banner
        tone={halt.engaged ? "warning" : "info"}
        title={
          halt.engaged
            ? t("pricing.features.repricingPolicies.ui.shared.halt.engaged.title")
            : t("pricing.features.repricingPolicies.ui.shared.halt.released.title")
        }
        description={
          halt.engaged
            ? t("pricing.features.repricingPolicies.ui.shared.halt.engaged.description", {
                engagedAt: halt.engagedAt ? formatDateTime(halt.engagedAt) : "",
              })
            : t("pricing.features.repricingPolicies.ui.shared.halt.released.description")
        }
        actions={
          <Switch
            label={t("pricing.features.repricingPolicies.ui.shared.halt.switch")}
            checked={halt.engaged}
            disabled={disabled}
            onCheckedChange={(checked) => setPending(checked)}
          />
        }
      />
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        tone="warning"
        title={
          engaging
            ? t("pricing.features.repricingPolicies.ui.shared.halt.engage.title")
            : t("pricing.features.repricingPolicies.ui.shared.halt.release.title")
        }
        description={
          engaging
            ? t("pricing.features.repricingPolicies.ui.shared.halt.engage.description")
            : t("pricing.features.repricingPolicies.ui.shared.halt.release.description")
        }
        confirmLabel={
          engaging
            ? t("pricing.features.repricingPolicies.ui.shared.halt.engage.confirm")
            : t("pricing.features.repricingPolicies.ui.shared.halt.release.confirm")
        }
        cancelLabel={t("pricing.features.repricingPolicies.ui.shared.cancel")}
        onConfirm={() => {
          if (pending !== null) onHaltChange(pending);
          setPending(null);
        }}
      />
    </Stack>
  );
}

// Pause and resume are an in-place row transition: the button disables while
// its policy's transition is in flight and the row re-renders with the result.
export function RepricingLifecycleButton({
  policyId,
  status,
  busy,
  onPause,
  onResume,
}: {
  policyId: string;
  status: RepricingPolicyState["status"];
  busy: boolean;
  onPause: (policyId: string) => void;
  onResume: (policyId: string) => void;
}) {
  if (status === "deleted") return null;
  return status === "active" ? (
    <Button tone="secondary" size="sm" disabled={busy} loading={busy} onClick={() => onPause(policyId)}>
      {t("pricing.features.repricingPolicies.ui.shared.pause")}
    </Button>
  ) : (
    <Button tone="secondary" size="sm" disabled={busy} loading={busy} onClick={() => onResume(policyId)}>
      {t("pricing.features.repricingPolicies.ui.shared.resume")}
    </Button>
  );
}

function dryRunStatusLabel(status: RepricingDryRun["status"]): string {
  switch (status) {
    case "queued":
      return t("pricing.features.repricingPolicies.ui.policyList.dryRuns.status.queued");
    case "running":
      return t("pricing.features.repricingPolicies.ui.policyList.dryRuns.status.running");
    case "completed":
      return t("pricing.features.repricingPolicies.ui.policyList.dryRuns.status.completed");
    case "failed":
      return t("pricing.features.repricingPolicies.ui.policyList.dryRuns.status.failed");
  }
}

function dryRunStatusTone(status: RepricingDryRun["status"]) {
  switch (status) {
    case "completed":
      return "success" as const;
    case "failed":
      return "danger" as const;
    case "queued":
    case "running":
      return "info" as const;
  }
}

export function PricingRepricingPolicyListPage({
  policies,
  halt,
  dryRuns,
  loading = false,
  loadFailed = false,
  errorMessage = null,
  busyPolicyId = null,
  onHaltChange,
  onPause,
  onResume,
}: {
  policies: readonly RepricingPolicyListRow[];
  halt: RepricingHaltState;
  dryRuns: readonly RepricingDryRun[];
  loading?: boolean;
  loadFailed?: boolean;
  errorMessage?: string | null;
  busyPolicyId?: string | null;
  onHaltChange: (engaged: boolean) => void;
  onPause: (policyId: string) => void;
  onResume: (policyId: string) => void;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("pricing.features.repricingPolicies.ui.policyList.eyebrow")}
        title={t("pricing.features.repricingPolicies.ui.policyList.title")}
        description={t("pricing.features.repricingPolicies.ui.policyList.description")}
      />
      <Stack gap={6}>
        {errorMessage ? (
          <Banner
            tone="danger"
            role="alert"
            title={t("pricing.features.repricingPolicies.ui.shared.actionError.title")}
            description={errorMessage}
          />
        ) : null}
        <RepricingHaltControl halt={halt} disabled={loading || loadFailed} onHaltChange={onHaltChange} />
        <PageSection title={t("pricing.features.repricingPolicies.ui.policyList.caption")}>
          {loadFailed ? (
            <Banner
              tone="danger"
              title={t("pricing.features.repricingPolicies.ui.policyList.error.title")}
              description={t("pricing.features.repricingPolicies.ui.policyList.error.description")}
            />
          ) : !loading && policies.length === 0 ? (
            <EmptyState
              data-testid="repricing-policy-list-empty"
              title={t("pricing.features.repricingPolicies.ui.policyList.empty.title")}
              description={t("pricing.features.repricingPolicies.ui.policyList.empty.description")}
            />
          ) : (
            <DataTable
              data-testid="repricing-policy-list"
              caption={t("pricing.features.repricingPolicies.ui.policyList.caption")}
              rows={[...policies]}
              loading={loading}
              getRowId={(policy) => policy.policyId ?? ""}
              columns={[
                {
                  key: "name",
                  header: t("pricing.features.repricingPolicies.ui.policyList.column.name"),
                  cell: (policy) => (
                    <LinkButton href={repricingPolicyHref(policy.policyId ?? "")} tone="ghost" size="sm">
                      {policy.name ?? t("pricing.features.repricingPolicies.ui.policyList.unnamed")}
                    </LinkButton>
                  ),
                },
                {
                  key: "status",
                  header: t("pricing.features.repricingPolicies.ui.policyList.column.status"),
                  cell: (policy) => {
                    const badge = repricingStatusBadge(policy.status, halt.engaged);
                    return <Badge tone={badge.tone}>{badge.label}</Badge>;
                  },
                },
                {
                  key: "scope",
                  header: t("pricing.features.repricingPolicies.ui.policyList.column.scope"),
                  cell: (policy) => repricingScopeLabel(policy.scope),
                },
                {
                  key: "budget",
                  header: t("pricing.features.repricingPolicies.ui.policyList.column.budget"),
                  cell: (policy) => repricingBudgetLabel(policy.changesUsedToday, policy.maxChangesPerDay),
                },
                {
                  key: "actions",
                  header: t("pricing.features.repricingPolicies.ui.policyList.column.actions"),
                  align: "right",
                  cell: (policy) => (
                    <RepricingLifecycleButton
                      policyId={policy.policyId ?? ""}
                      status={policy.status}
                      busy={busyPolicyId === policy.policyId}
                      onPause={onPause}
                      onResume={onResume}
                    />
                  ),
                },
              ]}
            />
          )}
        </PageSection>
        <PageSection title={t("pricing.features.repricingPolicies.ui.policyList.dryRuns.title")}>
          <DataTable
            data-testid="repricing-dry-runs"
            caption={t("pricing.features.repricingPolicies.ui.policyList.dryRuns.caption")}
            rows={[...dryRuns]}
            loading={loading}
            getRowId={(dryRun) => dryRun.dryRunId}
            emptyTitle={t("pricing.features.repricingPolicies.ui.policyList.dryRuns.empty.title")}
            emptyDescription={t("pricing.features.repricingPolicies.ui.policyList.dryRuns.empty.description")}
            columns={[
              {
                key: "requested",
                header: t("pricing.features.repricingPolicies.ui.policyList.dryRuns.column.requested"),
                cell: (dryRun) => formatDateTime(dryRun.requestedAt),
              },
              {
                key: "status",
                header: t("pricing.features.repricingPolicies.ui.policyList.dryRuns.column.status"),
                cell: (dryRun) => (
                  <Badge tone={dryRunStatusTone(dryRun.status)}>{dryRunStatusLabel(dryRun.status)}</Badge>
                ),
              },
              {
                key: "evaluated",
                header: t("pricing.features.repricingPolicies.ui.policyList.dryRuns.column.evaluated"),
                align: "right",
                cell: (dryRun) =>
                  dryRun.summary
                    ? formatRepricingCount(dryRun.summary.listingsEvaluated)
                    : t("pricing.features.repricingPolicies.ui.policyList.dryRuns.notFinished"),
              },
            ]}
          />
        </PageSection>
      </Stack>
    </Page>
  );
}
