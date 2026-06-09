import { useMemo, useState, type ReactNode } from "react";
import { Button, SectionNavigation, type SectionNavigationGroup } from "../components/actions";
import {
  BulkActionBar,
  BulkActionPanel,
  BulkActionSurface,
  type DataColumn,
  DataTable,
  FilterArea,
  KeyValueList,
  OperationalStatusBanner,
  TaskReference,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type WorkflowReadinessItem,
} from "../components/data-display";
import { Badge, EmptyState, SideSheet } from "../components/feedback";
import { MetricStrip } from "./app-shells";

type ObservationStatus = "ready" | "blocked" | "denied" | "degraded" | "stale" | "success";

interface WorkbenchObservation {
  id: string;
  sourceLabel: string;
  sourcePath: string;
  provider: string;
  status: ObservationStatus;
  statusLabel: string;
  blockers: string[];
  promotionTarget: string;
  evidenceSummary: string;
  commandPreview: string;
  auditRef: string;
  diagnostics: string;
  selectable: boolean;
}

export interface DenseAdminWorkbenchProofProps {
  loading?: boolean;
  empty?: boolean;
}

const navigationGroups: SectionNavigationGroup[] = [
  {
    key: "primary-workflow",
    label: "Primary workflow",
    items: [
      {
        key: "import-promotion",
        label: "Import to promotion",
        href: "/admin/catalog/primary-workbench?section=import-promotion",
        icon: "refreshCcw",
        description: "Pull, review, promote",
        count: 168,
      },
      {
        key: "promotion-preview",
        label: "Promotion preview",
        href: "/admin/catalog/primary-workbench?section=promotion-preview",
        icon: "check",
        description: "Catalog writes",
        count: 24,
      },
    ],
  },
  {
    key: "unblock-provider-data",
    label: "Unblock provider data",
    items: [
      {
        key: "provider-health",
        label: "Provider health",
        href: "/admin/catalog/provider-health",
        icon: "warning",
        description: "Transport and budgets",
        state: "warning",
        statusLabel: "Degraded",
      },
      {
        key: "profile-readiness",
        label: "Profile readiness",
        href: "/admin/catalog/profile-readiness",
        icon: "settings",
        description: "Scopes and mappings",
        state: "blocked",
        statusLabel: "Blocked",
      },
    ],
  },
  {
    key: "govern-recover",
    label: "Govern and recover",
    items: [
      {
        key: "jobs-recovery",
        label: "Jobs and recovery",
        href: "/admin/catalog/jobs-recovery",
        icon: "clock",
        description: "Durable imports",
        count: 3,
      },
      {
        key: "rollout-controls",
        label: "Rollout controls",
        href: "/admin/catalog/rollout-controls",
        icon: "shield",
        description: "Kill switches",
      },
    ],
  },
  {
    key: "release-evidence",
    label: "Verify release evidence",
    items: [
      {
        key: "audit-evidence",
        label: "Audit evidence",
        href: "/admin/catalog/audit-evidence",
        icon: "book",
        description: "Proof and signoff",
      },
      {
        key: "legacy-surface",
        label: "Old integrations surface",
        icon: "trash",
        description: "Deleted at launch",
        state: "disabled",
        statusLabel: "Removed",
        disabled: true,
      },
    ],
  },
];

const observations: WorkbenchObservation[] = [
  {
    id: "obs-psa-charizard",
    sourceLabel: "1999 Pokemon Base Set Charizard Holo PSA 9",
    sourcePath:
      "provider/tcgplayer/catalog/products/1999-pokemon-game-base-set-charizard-holo-rare-4/variants/psa-9-first-edition",
    provider: "TCGplayer",
    status: "ready",
    statusLabel: "Ready",
    blockers: ["None"],
    promotionTarget: "Catalog Item",
    evidenceSummary: "Provider facts normalized and ready for promotion preview.",
    commandPreview: "promoteObservation({ observationId: 'obs-psa-charizard', target: 'catalog-item' })",
    auditRef: "audit:cat-import:2026-06-09T14:21:10Z",
    diagnostics: "Transport 184 ms, profile v12, freshness 2 min.",
    selectable: true,
  },
  {
    id: "obs-long-path",
    sourceLabel: "Magic The Gathering Commander Legends Battle for Baldur's Gate Collector Booster Display",
    sourcePath:
      "provider/mtgjson/sealed-products/commander-legends-battle-for-baldurs-gate/collector-booster-display/case/english/very-long-source-path-for-wrap-proof",
    provider: "MTGJSON",
    status: "stale",
    statusLabel: "Stale",
    blockers: ["Refresh provider pull before promotion"],
    promotionTarget: "Reference Record",
    evidenceSummary: "Observation exists, but provider freshness has crossed the promotion SLO.",
    commandPreview: "pullProviderData({ provider: 'MTGJSON', scope: 'sealed-products' })",
    auditRef: "audit:cat-import:2026-06-09T13:02:44Z",
    diagnostics: "Freshness 49 h, last successful import job job_cat_8KD.",
    selectable: true,
  },
  {
    id: "obs-denied",
    sourceLabel: "Pokemon Scarlet and Violet Promo with restricted source evidence",
    sourcePath: "provider/private-feed/products/sv-promo/restricted-redacted",
    provider: "Private feed",
    status: "denied",
    statusLabel: "Denied",
    blockers: ["Catalog writer role required", "Restricted evidence redacted"],
    promotionTarget: "Catalog Item",
    evidenceSummary: "RBAC denies promotion; inspect redacted evidence only.",
    commandPreview: "promoteObservation({ observationId: 'obs-denied' })",
    auditRef: "audit:cat-import:2026-06-09T12:18:02Z",
    diagnostics: "Security policy catalog.write denied for current membership.",
    selectable: false,
  },
  {
    id: "obs-degraded",
    sourceLabel: "Sports card provider rookie parallel with partial image facts",
    sourcePath: "provider/cardmarket/products/rookie-parallel/images/partial",
    provider: "Cardmarket",
    status: "degraded",
    statusLabel: "Degraded",
    blockers: ["Provider transport retry budget active"],
    promotionTarget: "External Reference",
    evidenceSummary: "Core identity facts are present; image facts are delayed by provider transport.",
    commandPreview: "retryProviderSlice({ provider: 'Cardmarket', slice: 'images' })",
    auditRef: "audit:cat-import:2026-06-09T11:47:38Z",
    diagnostics: "Retry budget 2/5, next attempt in 9 min.",
    selectable: true,
  },
];

const readinessItems: WorkflowReadinessItem[] = [
  {
    key: "provider-transport",
    label: "Provider transport",
    status: "warning",
    statusLabel: "Degraded",
    description: "Import remains usable, but image facts are under retry budget.",
    meta: <TaskReference label="Budget" value="retry-budget-cardmarket-images" displayValue="2/5 retries" />,
  },
  {
    key: "security-privacy",
    label: "Security and privacy",
    status: "blocked",
    statusLabel: "Denied action",
    description: "Restricted evidence stays redacted and promotion commands fail closed without Catalog writer access.",
    meta: <TaskReference label="Policy" value="catalog.write" displayValue="catalog.write" />,
  },
  {
    key: "resilience",
    label: "Durable import recovery",
    status: "passed",
    statusLabel: "Healthy",
    description: "Last import job can resume without duplicate promotion commands.",
    meta: <TaskReference label="Job" value="job_cat_8KD" displayValue="job_cat_8KD" />,
  },
  {
    key: "stale-read-model",
    label: "Read-model freshness",
    status: "warning",
    statusLabel: "Stale",
    description: "Stale observations must be refreshed before promotion preview.",
  },
];

const proofStateItems: WorkflowReadinessItem[] = [
  {
    key: "blocked",
    label: "Blocked state",
    status: "blocked",
    statusLabel: "Blocked",
    description: "A missing profile, denied role, or failed invariant disables unsafe commands.",
  },
  {
    key: "empty",
    label: "Empty state",
    status: "pending",
    statusLabel: "Empty",
    description: "No matching observations keeps the import action visible instead of stranding the operator.",
  },
  {
    key: "provider-transport",
    label: "Provider transport state",
    status: "warning",
    statusLabel: "Retrying",
    description: "Transport degradation is visible without burying the primary pull/review/promote path.",
  },
  {
    key: "error-success",
    label: "Error and success states",
    status: "passed",
    statusLabel: "Covered",
    description: "Command previews show the failed-closed error path and the accepted promotion path.",
  },
];

function statusTone(status: ObservationStatus) {
  if (status === "ready" || status === "success") {
    return "success";
  }
  if (status === "blocked" || status === "denied") {
    return "danger";
  }
  if (status === "degraded" || status === "stale") {
    return "warning";
  }
  return "neutral";
}

function ObservationEvidenceSheet({ observation }: { observation: WorkbenchObservation }) {
  return (
    <SideSheet
      title={`Evidence for ${observation.sourceLabel}`}
      description="Redacted provider facts, diagnostics, command preview, and audit references stay in context."
      closeLabel="Close evidence"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          Evidence
        </Button>
      }
      footer={
        <Button size="sm" tone={observation.selectable ? "primary" : "secondary"} disabled={!observation.selectable}>
          {observation.selectable ? "Use in preview" : "Promotion denied"}
        </Button>
      }
    >
      <div className="grid gap-4">
        <KeyValueList
          items={[
            { key: "Provider", value: observation.provider },
            { key: "Redacted fact", value: observation.evidenceSummary },
            { key: "Diagnostics", value: observation.diagnostics },
            { key: "Audit reference", value: observation.auditRef },
          ]}
        />
        <div className="rounded-tokenMd border border-muted bg-surface-2 p-3">
          <div className="text-xs font-semibold uppercase text-tertiary">Command preview</div>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-secondary">
            {observation.commandPreview}
          </pre>
        </div>
      </div>
    </SideSheet>
  );
}

function renderBlockers(blockers: readonly string[]) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {blockers.map((blocker) => (
        <Badge key={blocker} tone={blocker === "None" ? "success" : "warning"}>
          {blocker}
        </Badge>
      ))}
    </div>
  );
}

export function DenseAdminWorkbenchProof({ loading = false, empty = false }: DenseAdminWorkbenchProofProps) {
  const [activeSection, setActiveSection] = useState("import-promotion");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(["obs-psa-charizard", "obs-degraded"]));
  const rows = empty ? [] : observations;
  const visibleRowIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const selectedCount = Array.from(selectedKeys).filter((key) => visibleRowIds.has(key)).length;
  const columns = useMemo<DataColumn<WorkbenchObservation>[]>(
    () => [
      {
        key: "source",
        header: "Source Observation",
        sortable: true,
        cell: (row) => (
          <div className="grid min-w-0 gap-1">
            <div className="break-words text-sm font-semibold text-foreground">{row.sourceLabel}</div>
            <div className="break-all font-mono text-xs leading-5 text-tertiary">{row.sourcePath}</div>
          </div>
        ),
      },
      {
        key: "provider",
        header: "Provider",
        mobileLabel: "Provider",
        cell: (row) => row.provider,
      },
      {
        key: "status",
        header: "Status",
        mobileLabel: "Status",
        cell: (row) => <Badge tone={statusTone(row.status)}>{row.statusLabel}</Badge>,
      },
      {
        key: "blockers",
        header: "Blockers",
        mobileLabel: "Blockers",
        cell: (row) => renderBlockers(row.blockers),
      },
      {
        key: "promotion",
        header: "Promotion",
        mobileLabel: "Promotion",
        cell: (row) => row.promotionTarget,
      },
      {
        key: "actions",
        header: "Actions",
        mobileLabel: "Actions",
        cell: (row) => (
          <div className="flex min-w-0 flex-wrap justify-end gap-2">
            <ObservationEvidenceSheet observation={row} />
            <Button
              size="sm"
              tone="primary"
              disabled={!row.selectable}
              aria-label={
                row.selectable ? `Preview promotion for ${row.sourceLabel}` : `Promotion denied for ${row.sourceLabel}`
              }
            >
              Preview
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <section className="grid gap-5" data-proof-artifact="dense-admin-workbench">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-accent">Catalog control plane proof</div>
          <h1 className="mt-1 font-heading text-2xl font-semibold leading-tight text-foreground md:text-3xl">
            Import provider data, review Source Observations, promote Catalog facts
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-secondary">
            Supporting health, profile, rollout, and evidence workflows stay grouped around the primary
            import-to-promotion path instead of becoming equal destinations.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
          <Button leadingIcon="refreshCcw">Pull provider data</Button>
          <Button tone="secondary" leadingIcon="check">
            Open promotion preview
          </Button>
        </div>
      </div>

      <MetricStrip
        items={[
          { label: "Source Observations", value: "168", trend: "24 ready for preview" },
          { label: "Provider pulls", value: "3", trend: "1 degraded transport" },
          { label: "Denied actions", value: "2", trend: "RBAC fail-closed" },
          { label: "Catalog promotions", value: "24", trend: "Queued for review" },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <div className="lg:sticky lg:top-20">
          <SectionNavigation
            groups={navigationGroups}
            activeKey={activeSection}
            label="Catalog control plane sections"
            mobileLabel="Choose Catalog workflow"
            onSelect={setActiveSection}
          />
        </div>

        <BulkActionSurface>
          <div className="grid min-w-0 gap-4">
            <OperationalStatusBanner
              tone="warning"
              title="Provider transport is degraded, but the primary path remains usable"
              description="Operators can keep reviewing fresh observations while delayed image facts retry in the background."
              action={
                <Button size="sm" tone="secondary" leadingIcon="externalLink">
                  View transport evidence
                </Button>
              }
            />

            <WorkflowModule
              title="Import to promotion queue"
              description="The table keeps import context, Source Observation evidence, blockers, and promotion actions together."
              status={<Badge tone="accent">Primary path</Badge>}
              actions={
                <>
                  <Button size="sm" tone="secondary" leadingIcon="filter">
                    Save view
                  </Button>
                  <Button size="sm" leadingIcon="refreshCcw">
                    Pull provider data
                  </Button>
                </>
              }
              headingLevel={2}
              density="compact"
            >
              <FilterArea
                sticky={false}
                activeFilterCount={3}
                panelTitle="Source Observation filters"
                panelDescription="Keep provider, scope, profile, and return path together while filtering."
                actions={
                  <Button size="sm" tone="secondary">
                    Reset
                  </Button>
                }
              >
                <Badge tone="info">Provider: all</Badge>
                <Badge tone="info">Scope: catalogable</Badge>
                <Badge tone="warning">Only actionable blockers</Badge>
                <Badge tone="neutral">Profile v12</Badge>
              </FilterArea>

              {empty ? (
                <EmptyState
                  title="No Source Observations match this view"
                  description="Pull provider data or clear support-only filters to return to the primary queue."
                  actions={<Button leadingIcon="refreshCcw">Pull provider data</Button>}
                />
              ) : null}

              <DataTable
                rows={rows}
                columns={columns}
                getRowId={(row) => row.id}
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
                isRowSelectable={(row) => row.selectable}
                loading={loading}
                loadingRows={3}
                density="compact"
                emptyTitle="No Source Observations match this view"
                emptyDescription="Pull provider data or adjust filters before promotion."
              />

              <div className="flex flex-col gap-2 border-t border-muted pt-3 text-sm text-secondary sm:flex-row sm:items-center sm:justify-between">
                <span>Showing 1-4 of 168 observations for provider context TCGdx / English / profile v12.</span>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" tone="secondary" disabled>
                    Previous
                  </Button>
                  <Button size="sm" tone="secondary">
                    Next
                  </Button>
                </div>
              </div>
            </WorkflowModule>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
              <WorkflowModule
                title="Readiness and support states"
                description="Support signals explain why a command can or cannot complete without taking over the workbench."
                density="compact"
                status={<Badge tone="warning">Attention</Badge>}
              >
                <WorkflowReadinessChecklist items={readinessItems} />
              </WorkflowModule>

              <WorkflowModule
                title="State coverage proof"
                description="This artifact covers required blocked, empty, denied, degraded, stale, provider, security, privacy, resilience, error, and success states."
                density="compact"
                status={<Badge tone="info">QA</Badge>}
              >
                <WorkflowReadinessChecklist items={proofStateItems} />
              </WorkflowModule>
            </div>

            {selectedCount > 0 ? (
              <BulkActionBar
                count={selectedCount}
                formatSelectedLabel={(count) => `${count} Source Observation${count === 1 ? "" : "s"} selected`}
                primaryActions={
                  <BulkActionPanel
                    title="Configure promotion preview"
                    description="Preview Catalog-owned writes before promotion commands run."
                    triggerLabel="Configure preview"
                    footer={<Button size="sm">Queue preview</Button>}
                  >
                    <KeyValueList
                      items={[
                        { key: "Selection", value: `${selectedCount} Source Observations` },
                        { key: "Command", value: "Preview promotion only; no Catalog writes yet." },
                        { key: "Failure mode", value: "Denied and stale observations fail closed." },
                      ]}
                    />
                  </BulkActionPanel>
                }
                secondaryActions={
                  <Button size="sm" tone="secondary" onClick={() => setSelectedKeys(new Set())}>
                    Clear selection
                  </Button>
                }
                overflowActions={[
                  { key: "copy-audit", label: "Copy audit references", icon: "copy" },
                  { key: "export-redacted", label: "Export redacted evidence", icon: "externalLink" },
                ]}
              />
            ) : null}
          </div>
        </BulkActionSurface>
      </div>
    </section>
  );
}
