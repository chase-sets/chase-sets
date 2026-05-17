import { t } from "@chase-sets/localization";
import { useMemo, useState, type ReactNode } from "react";
import {
  BulkActionBar,
  Button,
  DataTable,
  Dialog,
  Inline,
  Select,
  Stack,
  StatusPill,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";

export type BulkLifecycleSelection =
  | Readonly<{ mode: "ids"; ids: readonly string[] }>
  | Readonly<{ mode: "filter"; query: unknown }>;

export type BulkLifecycleCandidate = Readonly<{
  id: string;
  label: string;
  status: string;
  outcome: string;
  reason: string | null;
}>;

export type BulkLifecyclePreview = Readonly<{
  action: string;
  ids: readonly string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: readonly BulkLifecycleCandidate[];
}>;

export type BulkLifecycleResult = Readonly<{
  action: string;
  ids: readonly string[];
  total: number;
  succeeded_count: number;
  skipped_count: number;
  failed_count: number;
  candidates: readonly BulkLifecycleCandidate[];
}>;

export type BulkLifecycleActionOption = Readonly<{
  value: string;
  label: string;
  tone?: "primary" | "secondary" | "danger";
}>;

export interface BulkLifecycleActionBarProps {
  entityName: string;
  selectedKeys: Set<string>;
  filterSelection?: BulkLifecycleSelection;
  filterCount?: number;
  actions: readonly BulkLifecycleActionOption[];
  extraActions?: ReactNode;
  clearSelection: () => void;
  preview: (
    action: string,
    selection: BulkLifecycleSelection,
  ) => Promise<BulkLifecyclePreview>;
  confirm: (
    action: string,
    selection: BulkLifecycleSelection,
  ) => Promise<BulkLifecycleResult>;
  onCompleted: () => void;
}

export function BulkLifecycleActionBar({
  entityName,
  selectedKeys,
  filterSelection,
  filterCount,
  actions,
  extraActions,
  clearSelection,
  preview,
  confirm,
  onCompleted,
}: BulkLifecycleActionBarProps) {
  const [selectedAction, setSelectedAction] = useState(actions[0]?.value ?? "");
  const [selection, setSelection] = useState<BulkLifecycleSelection | null>(null);
  const [previewResult, setPreviewResult] = useState<BulkLifecyclePreview | null>(null);
  const [confirmResult, setConfirmResult] = useState<BulkLifecycleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const columns = useMemo(() => buildColumns(), []);
  const rows = (confirmResult?.candidates ?? previewResult?.candidates ?? []).slice(0, 20);
  const actionLabel = actions.find((action) => action.value === selectedAction)?.label ?? selectedAction;
  const hasSelectedRows = selectedKeys.size > 0;
  const hasFilterScope = filterSelection !== undefined;
  const barCount = hasSelectedRows ? selectedKeys.size : filterCount ?? 0;

  async function handlePreviewSelected() {
    const nextSelection = { mode: "ids" as const, ids: [...selectedKeys] };
    await handlePreview(nextSelection);
  }

  async function handlePreviewMatching() {
    if (!filterSelection) {
      return;
    }

    await handlePreview(filterSelection);
  }

  async function handlePreview(nextSelection: BulkLifecycleSelection) {
    setBusy(true);
    setConfirmResult(null);

    try {
      const result = await preview(selectedAction, nextSelection);
      setSelection(nextSelection);
      setPreviewResult(result);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!selection || !previewResult) {
      return;
    }

    setBusy(true);
    try {
      const result = await confirm(previewResult.action, selection);
      setConfirmResult(result);
      clearSelection();
      onCompleted();
    } finally {
      setBusy(false);
    }
  }

  if ((!hasSelectedRows && !hasFilterScope) || actions.length === 0) {
    return null;
  }

  return (
    <>
      <BulkActionBar
        count={barCount}
        formatSelectedLabel={(count) =>
          hasSelectedRows
            ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.selected", {
                count,
                entityName,
              })
            : t("catalog.support.shellSupport.ui.bulkLifecycleActions.matching", {
                count,
                entityName,
              })
        }
        primaryActions={
          <Inline gap={2} align="end">
            <Select
              label={t("catalog.support.shellSupport.ui.bulkLifecycleActions.action")}
              value={selectedAction}
              onValueChange={setSelectedAction}
              items={actions.map((action) => ({
                label: action.label,
                value: action.value,
              }))}
            />
            <Button size="sm" onClick={handlePreviewSelected} loading={busy} disabled={!hasSelectedRows}>
              {t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview")}
            </Button>
          </Inline>
        }
        secondaryActions={
          <Inline gap={2} align="end">
            {hasFilterScope && (
              <Button size="sm" tone="secondary" onClick={handlePreviewMatching} loading={busy}>
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.matching")}
              </Button>
            )}
            {hasSelectedRows && (
              <Button size="sm" tone="secondary" onClick={clearSelection} disabled={busy}>
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.clear.selection")}
              </Button>
            )}
            {extraActions}
          </Inline>
        }
      />
      <Dialog
        open={previewResult !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewResult(null);
            setConfirmResult(null);
            setSelection(null);
          }
        }}
        title={
          confirmResult
            ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.result.title", { action: actionLabel })
            : t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.title", { action: actionLabel })
        }
        description={
          confirmResult
            ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.result.description", {
                succeeded: confirmResult.succeeded_count,
                skipped: confirmResult.skipped_count,
                failed: confirmResult.failed_count,
              })
            : previewResult
              ? t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.description", {
                  ready: previewResult.ready_count,
                  blocked: previewResult.blocked_count,
                })
              : undefined
        }
        footer={
          confirmResult ? (
            <Button onClick={() => setPreviewResult(null)}>
              {t("catalog.support.shellSupport.ui.bulkLifecycleActions.close")}
            </Button>
          ) : (
            <Inline gap={2}>
              <Button onClick={handleConfirm} loading={busy} disabled={!previewResult || previewResult.ready_count === 0}>
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.confirm")}
              </Button>
              <Button tone="secondary" onClick={() => setPreviewResult(null)} disabled={busy}>
                {t("catalog.support.shellSupport.ui.bulkLifecycleActions.cancel")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={3}>
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            density="compact"
            emptyTitle={t("catalog.support.shellSupport.ui.bulkLifecycleActions.no.records")}
          />
          {(confirmResult?.candidates.length ?? previewResult?.candidates.length ?? 0) > rows.length && (
            <Text tone="secondary">
              {t("catalog.support.shellSupport.ui.bulkLifecycleActions.truncated", {
                shown: rows.length,
                total: confirmResult?.candidates.length ?? previewResult?.candidates.length ?? 0,
              })}
            </Text>
          )}
        </Stack>
      </Dialog>
    </>
  );
}

function buildColumns(): DataColumn<BulkLifecycleCandidate>[] {
  return [
    {
      key: "label",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.record"),
      cell: (row) => row.label,
    },
    {
      key: "status",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.status"),
      cell: (row) => row.status,
    },
    {
      key: "outcome",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.outcome"),
      cell: (row) => <StatusPill>{row.outcome}</StatusPill>,
    },
    {
      key: "reason",
      header: t("catalog.support.shellSupport.ui.bulkLifecycleActions.reason"),
      cell: (row) => row.reason ?? "—",
    },
  ];
}
