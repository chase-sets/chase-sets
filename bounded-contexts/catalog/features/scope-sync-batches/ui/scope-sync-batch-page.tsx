import {
  Banner,
  Button,
  DataTable,
  HiddenInput,
  Inline,
  KeyValueList,
  LinkText,
  Page,
  PageHeader,
  PageSection,
  Select,
  Stack,
  StatusPill,
  Text,
  TextInput,
  WorkbenchForm,
  type DataColumn,
} from "@chase-sets/design-system";
import { catalogScopeProductDomains } from "../../scope-registry/domain/contract";
import type { ScopeSyncBatchPreview } from "../domain/batch";
import type { ScopeSyncBatchSnapshot, ScopeSyncBatchUnitSnapshot } from "../read-model/store";

export function ScopeSyncBatchPage({
  preview,
  batch,
  error,
}: Readonly<{
  preview: ScopeSyncBatchPreview | null;
  batch: ScopeSyncBatchSnapshot | null;
  error: string | null;
}>) {
  return (
    <Page>
      <PageHeader
        eyebrow="Catalog operations"
        title="Scope Sync Batches"
        description="Preview and run bounded synchronization across server-resolved Catalog Scope Records."
        actions={<LinkText href="/catalog/scopes">Back to scopes</LinkText>}
      />
      {error ? <Banner tone="danger" title="Batch command blocked" description={error} /> : null}
      <PageSection title="New batch">
        <WorkbenchForm variant="surface" method="post" action="/catalog/scopes/sync-batches">
          <Stack gap={4}>
            <Inline gap={3} wrap>
              <Select
                name="selectionMode"
                label="Selection"
                defaultValue="matching-scope"
                items={[
                  { label: "Matching scope", value: "matching-scope" },
                  { label: "Explicit Scope Record ids", value: "ids" },
                ]}
              />
              <Select
                name="productDomain"
                label="Product domain"
                defaultValue="pokemon"
                items={catalogScopeProductDomains.map((value) => ({ label: value, value }))}
              />
              <Select
                name="scopeKind"
                label="Scope kind"
                defaultValue="set"
                items={["product-line", "series", "expansion", "set"].map((value) => ({ label: value, value }))}
              />
              <TextInput name="languageCode" label="Language" defaultValue="en" />
              <TextInput
                name="scopeRecordIds"
                label="Scope Record ids"
                description="Comma-separated; used only for explicit selection."
              />
            </Inline>
            <Inline gap={3} wrap>
              <TextInput name="maxScopesPerTurn" label="Scopes per worker turn" type="number" defaultValue="1" />
              <TextInput
                name="defaultProviderConcurrency"
                label="Default provider concurrency"
                type="number"
                defaultValue="1"
              />
              <TextInput name="scrydexConcurrency" label="Scrydex concurrency" type="number" defaultValue="1" />
              <TextInput name="tcgdexRequestLimit" label="TCGdex request limit" type="number" defaultValue="1000" />
              <TextInput
                name="scrydexRateRequestLimit"
                label="Scrydex rate request limit"
                type="number"
                defaultValue="1000"
              />
              <TextInput name="scrydexRequestLimit" label="Scrydex credit limit" type="number" defaultValue="0" />
              <TextInput
                name="providerFailureThreshold"
                label="Circuit-breaker failures"
                type="number"
                defaultValue="3"
              />
            </Inline>
            <Inline gap={2}>
              <Button type="submit" name="intent" value="preview">
                Preview batch
              </Button>
            </Inline>
          </Stack>
        </WorkbenchForm>
      </PageSection>
      {preview ? <PreviewSection preview={preview} /> : null}
      {batch ? <BatchSection batch={batch} /> : null}
    </Page>
  );
}

function PreviewSection({ preview }: { preview: ScopeSyncBatchPreview }) {
  const sampleColumns: DataColumn<ScopeSyncBatchPreview["samples"][number]>[] = [
    { key: "scope", header: "Scope Record", cell: (sample) => <Text>{sample.scopeRecordId}</Text> },
    { key: "providers", header: "Providers", cell: (sample) => <Text>{sample.providerKeys.join(", ")}</Text> },
    {
      key: "requests",
      header: "Estimated requests",
      cell: (sample) => <Text>{sample.estimatedRequestCount ?? "Unavailable"}</Text>,
    },
    {
      key: "versions",
      header: "Evidence versions",
      cell: (sample) => (
        <Text>
          {sample.mappingVersions.map((mapping) => `${mapping.mappingId}@${mapping.version}`).join(", ") ||
            "No mapping"}
          {" · "}
          {sample.profileVersions
            .map((profile) => `${profile.providerKey}/${profile.profileKey}@${profile.profileVersion}`)
            .join(", ") || "No profile"}
        </Text>
      ),
    },
    { key: "blockers", header: "Blockers", cell: (sample) => <Text>{sample.blockerCount}</Text> },
  ];
  return (
    <PageSection title="Preview">
      <Stack gap={3}>
        <Banner
          tone={preview.confirmAllowed ? "success" : "warning"}
          title={preview.confirmAllowed ? "Batch is ready" : "Batch needs attention"}
          description={`${preview.counts.readyScopes} ready scopes, ${preview.counts.blockedScopes} blocked scopes, ${preview.counts.providerUnits} provider units.`}
        />
        <KeyValueList
          items={[
            { key: "Plan fingerprint", value: preview.planFingerprint },
            { key: "Resolved at", value: preview.resolvedAt },
            { key: "Scope count", value: String(preview.counts.scopes) },
          ]}
        />
        <KeyValueList
          items={Object.keys(preview.providerUnitTotals).map((providerKey) => ({
            key: `${providerKey} units / requests`,
            value: `${preview.providerUnitTotals[providerKey] ?? 0} / ${preview.providerRequestEstimates[providerKey] ?? "Unavailable"}`,
          }))}
        />
        <DataTable
          rows={[...preview.samples]}
          columns={sampleColumns}
          caption="Bounded Scope Sync Batch preview sample"
          getRowId={(sample) => sample.scopeRecordId}
          density="compact"
        />
        {preview.blockers.map((blocker, index) => (
          <Banner
            key={`${blocker.code}-${blocker.scopeRecordId ?? "batch"}-${index}`}
            tone="warning"
            title={blocker.code}
            description={blocker.message}
          />
        ))}
        {preview.confirmAllowed ? (
          <WorkbenchForm variant="button" method="post" action="/catalog/scopes/sync-batches">
            <HiddenInput name="intent" value="confirm" />
            <HiddenInput name="planFingerprint" value={preview.planFingerprint} />
            <HiddenInput name="selectionMode" value={preview.selection.mode} />
            {preview.selection.mode === "ids" ? (
              <HiddenInput name="scopeRecordIds" value={preview.selection.scopeRecordIds.join(",")} />
            ) : (
              <>
                <HiddenInput name="productDomain" value={preview.selection.query.productDomain ?? ""} />
                <HiddenInput name="scopeKind" value={preview.selection.query.scopeKind ?? ""} />
                <HiddenInput name="languageCode" value={preview.selection.query.languageCode ?? ""} />
              </>
            )}
            <HiddenInput name="maxScopesPerTurn" value={String(preview.budget.maxScopesPerTurn)} />
            <HiddenInput name="defaultProviderConcurrency" value={String(preview.budget.defaultProviderConcurrency)} />
            <HiddenInput name="scrydexConcurrency" value={String(preview.budget.providerConcurrency.scrydex ?? 1)} />
            <HiddenInput name="tcgdexRequestLimit" value={String(preview.budget.providerRequestLimits.tcgdex ?? 0)} />
            <HiddenInput
              name="scrydexRateRequestLimit"
              value={String(preview.budget.providerRequestLimits.scrydex ?? 0)}
            />
            <HiddenInput
              name="scrydexRequestLimit"
              value={String(preview.budget.creditedProviderRequestLimits.scrydex ?? 0)}
            />
            <HiddenInput name="providerFailureThreshold" value={String(preview.budget.providerFailureThreshold)} />
            <Button type="submit">Confirm and enqueue</Button>
          </WorkbenchForm>
        ) : null}
      </Stack>
    </PageSection>
  );
}

function BatchSection({ batch }: { batch: ScopeSyncBatchSnapshot }) {
  const columns: DataColumn<ScopeSyncBatchUnitSnapshot>[] = [
    { key: "scope", header: "Scope Record", cell: (unit) => <Text>{unit.scopeRecordId}</Text> },
    { key: "providers", header: "Providers", cell: (unit) => <Text>{unit.providerKeys.join(", ")}</Text> },
    {
      key: "state",
      header: "State",
      cell: (unit) => (
        <StatusPill tone={unit.state === "completed" ? "success" : unit.state === "failed" ? "danger" : "neutral"}>
          {unit.state}
        </StatusPill>
      ),
    },
    { key: "attempts", header: "Attempts", cell: (unit) => <Text>{unit.attemptCount}</Text> },
    {
      key: "recovery",
      header: "Recovery",
      cell: (unit) =>
        unit.state === "failed" || unit.state === "cancelled" ? (
          <WorkbenchForm variant="button" method="post" action="/catalog/scopes/sync-batches">
            <HiddenInput name="intent" value="retry-unit" />
            <HiddenInput name="batchId" value={batch.batchId} />
            <HiddenInput name="scopeRecordId" value={unit.scopeRecordId} />
            <Button type="submit" size="sm">
              Retry unit
            </Button>
          </WorkbenchForm>
        ) : (
          <Text tone="secondary">—</Text>
        ),
    },
  ];
  return (
    <PageSection title="Batch progress">
      <Stack gap={3}>
        <Inline gap={2} align="center">
          <StatusPill
            tone={batch.status === "completed" ? "success" : batch.status === "failed" ? "danger" : "neutral"}
          >
            {batch.status}
          </StatusPill>
          <Text>
            {batch.counts.completed} completed · {batch.counts.failed} failed · {batch.counts.running} running ·{" "}
            {batch.counts.queued} queued
          </Text>
        </Inline>
        <Inline gap={2}>
          {batch.status === "queued" || batch.status === "running" ? (
            <BatchCommand batchId={batch.batchId} intent="cancel" label="Cancel batch" />
          ) : null}
          {batch.status === "cancelled" ? (
            <BatchCommand batchId={batch.batchId} intent="resume" label="Resume batch" />
          ) : null}
        </Inline>
        {batch.circuitOpenProviders.length > 0 ? (
          <Banner
            tone="warning"
            title="Provider circuit open"
            description={`New work is paused for: ${batch.circuitOpenProviders.join(", ")}. Retry a failed unit after the provider is healthy.`}
          />
        ) : null}
        {batch.fastNoOp ? (
          <Banner
            tone="info"
            title="Already settled"
            description="The unchanged settled plan completed as a fast no-op."
          />
        ) : null}
        <DataTable
          rows={[...batch.units]}
          columns={columns}
          caption="Scope Sync Batch units"
          getRowId={(unit) => unit.scopeRecordId}
          density="compact"
        />
      </Stack>
    </PageSection>
  );
}

function BatchCommand({ batchId, intent, label }: { batchId: string; intent: string; label: string }) {
  return (
    <WorkbenchForm variant="button" method="post" action="/catalog/scopes/sync-batches">
      <HiddenInput name="intent" value={intent} />
      <HiddenInput name="batchId" value={batchId} />
      <Button type="submit" tone={intent === "cancel" ? "danger" : "primary"}>
        {label}
      </Button>
    </WorkbenchForm>
  );
}
