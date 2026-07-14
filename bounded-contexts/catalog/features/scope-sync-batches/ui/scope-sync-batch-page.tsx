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
import { t } from "@chase-sets/localization";
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
        eyebrow={t("catalog.features.scopeSyncBatches.ui.page.catalog.operations")}
        title={t("catalog.features.scopeSyncBatches.ui.page.title")}
        description={t("catalog.features.scopeSyncBatches.ui.page.description")}
        actions={
          <LinkText href="/catalog/scopes">{t("catalog.features.scopeSyncBatches.ui.page.back.to.scopes")}</LinkText>
        }
      />
      {error ? (
        <Banner
          tone="danger"
          title={t("catalog.features.scopeSyncBatches.ui.page.batch.command.blocked")}
          description={error}
        />
      ) : null}
      <PageSection title={t("catalog.features.scopeSyncBatches.ui.page.new.batch")}>
        <WorkbenchForm variant="surface" method="post" action="/catalog/scopes/sync-batches">
          <Stack gap={4}>
            <Inline gap={3} wrap>
              <Select
                name="selectionMode"
                label={t("catalog.features.scopeSyncBatches.ui.page.selection")}
                defaultValue="matching-scope"
                items={[
                  { label: t("catalog.features.scopeSyncBatches.ui.page.matching.scope"), value: "matching-scope" },
                  { label: t("catalog.features.scopeSyncBatches.ui.page.explicit.scope.record.ids"), value: "ids" },
                ]}
              />
              <Select
                name="productDomain"
                label={t("catalog.features.scopeSyncBatches.ui.page.product.domain")}
                defaultValue="pokemon"
                items={catalogScopeProductDomains.map((value) => ({ label: value, value }))}
              />
              <Select
                name="scopeKind"
                label={t("catalog.features.scopeSyncBatches.ui.page.scope.kind")}
                defaultValue="set"
                items={["product-line", "series", "expansion", "set"].map((value) => ({ label: value, value }))}
              />
              <TextInput
                name="languageCode"
                label={t("catalog.features.scopeSyncBatches.ui.page.language")}
                defaultValue="en"
              />
              <TextInput
                name="scopeRecordIds"
                label={t("catalog.features.scopeSyncBatches.ui.page.scope.record.ids")}
                description={t("catalog.features.scopeSyncBatches.ui.page.scope.record.ids.description")}
              />
            </Inline>
            <Inline gap={3} wrap>
              <TextInput
                name="maxScopesPerTurn"
                label={t("catalog.features.scopeSyncBatches.ui.page.scopes.per.worker.turn")}
                type="number"
                defaultValue="1"
              />
              <TextInput
                name="defaultProviderConcurrency"
                label={t("catalog.features.scopeSyncBatches.ui.page.default.provider.concurrency")}
                type="number"
                defaultValue="1"
              />
              <TextInput
                name="scrydexConcurrency"
                label={t("catalog.features.scopeSyncBatches.ui.page.scrydex.concurrency")}
                type="number"
                defaultValue="1"
              />
              <TextInput
                name="tcgdexRequestLimit"
                label={t("catalog.features.scopeSyncBatches.ui.page.tcgdex.request.limit")}
                type="number"
                defaultValue="1000"
              />
              <TextInput
                name="scrydexRateRequestLimit"
                label={t("catalog.features.scopeSyncBatches.ui.page.scrydex.rate.request.limit")}
                type="number"
                defaultValue="1000"
              />
              <TextInput
                name="scrydexRequestLimit"
                label={t("catalog.features.scopeSyncBatches.ui.page.scrydex.credit.limit")}
                type="number"
                defaultValue="0"
              />
              <TextInput
                name="providerFailureThreshold"
                label={t("catalog.features.scopeSyncBatches.ui.page.circuit.breaker.failures")}
                type="number"
                defaultValue="3"
              />
            </Inline>
            <Inline gap={2}>
              <Button type="submit" name="intent" value="preview">
                {t("catalog.features.scopeSyncBatches.ui.page.preview.batch")}
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
    {
      key: "scope",
      header: t("catalog.features.scopeSyncBatches.ui.page.scope.record"),
      cell: (sample) => <Text>{sample.scopeRecordId}</Text>,
    },
    {
      key: "providers",
      header: t("catalog.features.scopeSyncBatches.ui.page.providers"),
      cell: (sample) => <Text>{sample.providerKeys.join(", ")}</Text>,
    },
    {
      key: "requests",
      header: t("catalog.features.scopeSyncBatches.ui.page.estimated.requests"),
      cell: (sample) => (
        <Text>{sample.estimatedRequestCount ?? t("catalog.features.scopeSyncBatches.ui.page.unavailable")}</Text>
      ),
    },
    {
      key: "versions",
      header: t("catalog.features.scopeSyncBatches.ui.page.evidence.versions"),
      cell: (sample) => (
        <Text>
          {sample.mappingVersions.map((mapping) => `${mapping.mappingId}@${mapping.version}`).join(", ") ||
            t("catalog.features.scopeSyncBatches.ui.page.no.mapping")}
          {" · "}
          {sample.profileVersions
            .map((profile) => `${profile.providerKey}/${profile.profileKey}@${profile.profileVersion}`)
            .join(", ") || t("catalog.features.scopeSyncBatches.ui.page.no.profile")}
        </Text>
      ),
    },
    {
      key: "blockers",
      header: t("catalog.features.scopeSyncBatches.ui.page.blockers"),
      cell: (sample) => <Text>{sample.blockerCount}</Text>,
    },
  ];
  return (
    <PageSection title={t("catalog.features.scopeSyncBatches.ui.page.preview")}>
      <Stack gap={3}>
        <Banner
          tone={preview.confirmAllowed ? "success" : "warning"}
          title={
            preview.confirmAllowed
              ? t("catalog.features.scopeSyncBatches.ui.page.batch.ready")
              : t("catalog.features.scopeSyncBatches.ui.page.batch.needs.attention")
          }
          description={t("catalog.features.scopeSyncBatches.ui.page.preview.summary", {
            readyScopes: preview.counts.readyScopes,
            blockedScopes: preview.counts.blockedScopes,
            providerUnits: preview.counts.providerUnits,
          })}
        />
        <KeyValueList
          items={[
            { key: t("catalog.features.scopeSyncBatches.ui.page.plan.fingerprint"), value: preview.planFingerprint },
            { key: t("catalog.features.scopeSyncBatches.ui.page.resolved.at"), value: preview.resolvedAt },
            { key: t("catalog.features.scopeSyncBatches.ui.page.scope.count"), value: String(preview.counts.scopes) },
          ]}
        />
        <KeyValueList
          items={Object.keys(preview.providerUnitTotals).map((providerKey) => ({
            key: t("catalog.features.scopeSyncBatches.ui.page.provider.units.and.requests", { providerKey }),
            value: `${preview.providerUnitTotals[providerKey] ?? 0} / ${preview.providerRequestEstimates[providerKey] ?? t("catalog.features.scopeSyncBatches.ui.page.unavailable")}`,
          }))}
        />
        <DataTable
          rows={[...preview.samples]}
          columns={sampleColumns}
          caption={t("catalog.features.scopeSyncBatches.ui.page.preview.sample.caption")}
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
            <Button type="submit">{t("catalog.features.scopeSyncBatches.ui.page.confirm.and.enqueue")}</Button>
          </WorkbenchForm>
        ) : null}
      </Stack>
    </PageSection>
  );
}

function BatchSection({ batch }: { batch: ScopeSyncBatchSnapshot }) {
  const columns: DataColumn<ScopeSyncBatchUnitSnapshot>[] = [
    {
      key: "scope",
      header: t("catalog.features.scopeSyncBatches.ui.page.scope.record"),
      cell: (unit) => <Text>{unit.scopeRecordId}</Text>,
    },
    {
      key: "providers",
      header: t("catalog.features.scopeSyncBatches.ui.page.providers"),
      cell: (unit) => <Text>{unit.providerKeys.join(", ")}</Text>,
    },
    {
      key: "state",
      header: t("catalog.features.scopeSyncBatches.ui.page.state"),
      cell: (unit) => (
        <StatusPill tone={unit.state === "completed" ? "success" : unit.state === "failed" ? "danger" : "neutral"}>
          {unit.state}
        </StatusPill>
      ),
    },
    {
      key: "attempts",
      header: t("catalog.features.scopeSyncBatches.ui.page.attempts"),
      cell: (unit) => <Text>{unit.attemptCount}</Text>,
    },
    {
      key: "recovery",
      header: t("catalog.features.scopeSyncBatches.ui.page.recovery"),
      cell: (unit) =>
        unit.state === "failed" || unit.state === "cancelled" ? (
          <WorkbenchForm variant="button" method="post" action="/catalog/scopes/sync-batches">
            <HiddenInput name="intent" value="retry-unit" />
            <HiddenInput name="batchId" value={batch.batchId} />
            <HiddenInput name="scopeRecordId" value={unit.scopeRecordId} />
            <Button type="submit" size="sm">
              {t("catalog.features.scopeSyncBatches.ui.page.retry.unit")}
            </Button>
          </WorkbenchForm>
        ) : (
          <Text tone="secondary">—</Text>
        ),
    },
  ];
  return (
    <PageSection title={t("catalog.features.scopeSyncBatches.ui.page.batch.progress")}>
      <Stack gap={3}>
        <Inline gap={2} align="center">
          <StatusPill
            tone={batch.status === "completed" ? "success" : batch.status === "failed" ? "danger" : "neutral"}
          >
            {batch.status}
          </StatusPill>
          <Text>
            {t("catalog.features.scopeSyncBatches.ui.page.batch.progress.summary", {
              completed: batch.counts.completed,
              failed: batch.counts.failed,
              running: batch.counts.running,
              queued: batch.counts.queued,
            })}
          </Text>
        </Inline>
        <Inline gap={2}>
          {batch.status === "queued" || batch.status === "running" ? (
            <BatchCommand
              batchId={batch.batchId}
              intent="cancel"
              label={t("catalog.features.scopeSyncBatches.ui.page.cancel.batch")}
            />
          ) : null}
          {batch.status === "cancelled" ? (
            <BatchCommand
              batchId={batch.batchId}
              intent="resume"
              label={t("catalog.features.scopeSyncBatches.ui.page.resume.batch")}
            />
          ) : null}
        </Inline>
        {batch.circuitOpenProviders.length > 0 ? (
          <Banner
            tone="warning"
            title={t("catalog.features.scopeSyncBatches.ui.page.provider.circuit.open")}
            description={t("catalog.features.scopeSyncBatches.ui.page.provider.circuit.open.description", {
              providers: batch.circuitOpenProviders.join(", "),
            })}
          />
        ) : null}
        {batch.fastNoOp ? (
          <Banner
            tone="info"
            title={t("catalog.features.scopeSyncBatches.ui.page.already.settled")}
            description={t("catalog.features.scopeSyncBatches.ui.page.already.settled.description")}
          />
        ) : null}
        <DataTable
          rows={[...batch.units]}
          columns={columns}
          caption={t("catalog.features.scopeSyncBatches.ui.page.units.caption")}
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
