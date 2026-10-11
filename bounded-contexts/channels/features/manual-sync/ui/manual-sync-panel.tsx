import { useState } from "react";
import { useNavigation } from "react-router";
import {
  Badge,
  Button,
  FileDropzone,
  Form,
  HiddenInput,
  Inline,
  KeyValueList,
  MetricStrip,
  OperationalStatusBanner,
  Stack,
  TextInput,
  WorkflowModule,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import { channelSyncRunTerminalStates } from "../../tcgplayer-csv/domain/contracts";
import type {
  ManualSyncActionId,
  ManualSyncIngestReceipt,
  ManualSyncPanel,
  ManualSyncVerificationCandidate,
} from "../domain/contracts";

export type FounderSelectionProbe = Readonly<{
  fileName: string;
  byteSize: number;
  logicalRows: number;
  headerSha256: string;
  observedAt: string;
}>;

export type ManualSyncActionOutcome =
  | Readonly<{ kind: "manual-sync-ingest"; receipt: ManualSyncIngestReceipt }>
  | Readonly<{ kind: "manual-sync-staged-basis-guidance" }>;

export function ManualSyncPanelView({
  panel,
  outcome = null,
}: Readonly<{ panel: ManualSyncPanel; outcome?: ManualSyncActionOutcome | null }>) {
  const [selectionProbe, setSelectionProbe] = useState<FounderSelectionProbe | null>(null);
  const navigation = useNavigation();
  const pending = (intent: string, surface?: string) =>
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === intent &&
    (surface === undefined || navigation.formData.get("surface") === surface);
  const run = panel.run;
  const state = run?.state ?? "none";
  const recovery = panel.attentionReason === "recovery";
  const settled = run !== null && channelSyncRunTerminalStates.some((terminal) => terminal === run.state);
  return (
    <WorkflowModule
      data-testid="manual-sync-panel"
      title={t("channels.manualSync.title")}
      description={t("channels.manualSync.description")}
      status={
        <Badge tone={recovery ? "warning" : stateTone(state)}>
          {recovery ? t("channels.manualSync.recovery.badge") : stateLabel(state)}
        </Badge>
      }
    >
      {recovery ? (
        <OperationalStatusBanner
          data-testid="manual-sync-recovery"
          tone="warning"
          title={t("channels.manualSync.recovery.title")}
          description={t("channels.manualSync.recovery.description")}
        />
      ) : null}
      <OperationalStatusBanner
        tone={panel.inboundCoverage.state === "live" ? "success" : "warning"}
        title={t(
          panel.inboundCoverage.state === "live"
            ? "channels.manualSync.coverage.live"
            : "channels.manualSync.coverage.dark",
        )}
        description={t(
          panel.inboundCoverage.state === "live"
            ? "channels.manualSync.coverage.live.description"
            : coverageReasonKeys[panel.inboundCoverage.reason],
        )}
      />
      <MetricStrip
        items={[
          { label: t("channels.manualSync.metric.requested"), value: String(panel.requestedListingCount) },
          { label: t("channels.manualSync.metric.composed"), value: String(panel.composedListingCount) },
          ...(settled
            ? []
            : [{ label: t("channels.manualSync.metric.lease"), value: leaseLabel(panel.leaseCountdownMs) }]),
        ]}
      />
      {run ? (
        <KeyValueList
          data-testid="manual-sync-lease-facts"
          density="compact"
          items={[
            { key: t("channels.manualSync.lease.expiresAt"), value: run.leaseExpiresAt },
            ...(run.uploadAttemptedAt === null
              ? []
              : [{ key: t("channels.manualSync.lease.uploadAttemptedAt"), value: run.uploadAttemptedAt }]),
          ]}
        />
      ) : null}
      {outcome?.kind === "manual-sync-staged-basis-guidance" ? (
        <OperationalStatusBanner
          data-testid="manual-sync-staged-basis-guidance"
          tone="warning"
          title={t("channels.manualSync.compose.stagedBasis.title")}
          description={t("channels.manualSync.compose.stagedBasis.description")}
        />
      ) : null}
      <Inline gap={2} wrap>
        {panel.actions.includes("compose") ? (
          <EmptyAction intent="compose" labelKey="channels.manualSync.action.compose" submitting={pending("compose")} />
        ) : null}
        {panel.actions.includes("retry-clamp") && run ? (
          <RunAction
            intent="retry-clamp"
            labelKey="channels.manualSync.action.retryClamp"
            runId={run.runId}
            revision={run.revision}
            submitting={pending("retry-clamp")}
          />
        ) : null}
        {panel.actions.includes("download") && run ? (
          <DownloadAction connectionId={panel.connection.connectionId} runId={run.runId} revision={run.revision} />
        ) : null}
        {panel.actions.includes("record-validation-cancellation") && run ? (
          <RunAction
            intent="validation-cancelled"
            labelKey="channels.manualSync.action.cancel"
            runId={run.runId}
            revision={run.revision}
            submitting={pending("validation-cancelled")}
          />
        ) : null}
        {panel.actions.includes("release") && run ? (
          <RunAction
            intent="release"
            labelKey="channels.manualSync.action.release"
            runId={run.runId}
            revision={run.revision}
            submitting={pending("release")}
          />
        ) : null}
      </Inline>
      {panel.actions.includes("record-upload-attempt") && run ? (
        <RouterForm method="post" submitting={pending("upload-attempt")}>
          <HiddenInput name="intent" value="upload-attempt" />
          <HiddenInput name="runId" value={run.runId} />
          <HiddenInput name="expectedRevision" value={String(run.revision)} />
          <TextInput name="fileName" label={t("channels.manualSync.file.staged.label")} required />
          <Button type="submit">{t("channels.manualSync.action.uploadAttempt")}</Button>
        </RouterForm>
      ) : null}
      {panel.actions.includes("ingest-live") ? (
        <ExportForm
          surface="live"
          label={t("channels.manualSync.action.ingestLive")}
          submitting={pending("ingest", "live")}
          onProbe={setSelectionProbe}
        />
      ) : null}
      {panel.actions.includes("ingest-staged") ? (
        <ExportForm
          surface="staged"
          label={t("channels.manualSync.action.ingestStaged")}
          submitting={pending("ingest", "staged")}
        />
      ) : null}
      {selectionProbe ? (
        <OperationalStatusBanner
          data-testid="founder-export-selection-probe"
          tone="info"
          title={t("channels.manualSync.probe.summary", selectionProbe)}
          description={t("channels.manualSync.probe.detail", selectionProbe)}
        />
      ) : null}
      {outcome?.kind === "manual-sync-ingest" ? <IngestReceipt receipt={outcome.receipt} /> : null}
      {panel.actions.includes("verify") && run ? (
        <VerifyForm
          runId={run.runId}
          revision={run.revision}
          candidate={panel.verificationCandidate}
          submitting={pending("verify")}
        />
      ) : null}
    </WorkflowModule>
  );
}

const coverageReasonKeys = {
  "no-inbound-authority": "channels.manualSync.coverage.dark.description",
  "inbound-authority-revoked": "channels.manualSync.coverage.revoked.description",
  "provider-has-no-inbound": "channels.manualSync.coverage.unsupported.description",
  "inbound-authority-failing": "channels.manualSync.coverage.failing.description",
} as const;

function EmptyAction({
  intent,
  labelKey,
  submitting,
}: Readonly<{ intent: string; labelKey: Parameters<typeof t>[0]; submitting: boolean }>) {
  return (
    <RouterForm method="post" spacing="none" submitting={submitting}>
      <HiddenInput name="intent" value={intent} />
      <Button type="submit">{t(labelKey)}</Button>
    </RouterForm>
  );
}

function RunAction({
  intent,
  labelKey,
  runId,
  revision,
  submitting,
}: Readonly<{
  intent: string;
  labelKey: Parameters<typeof t>[0];
  runId: string;
  revision: number;
  submitting: boolean;
}>) {
  return (
    <RouterForm method="post" spacing="none" submitting={submitting}>
      <HiddenInput name="intent" value={intent} />
      <HiddenInput name="runId" value={runId} />
      <HiddenInput name="expectedRevision" value={String(revision)} />
      <Button type="submit">{t(labelKey)}</Button>
    </RouterForm>
  );
}

function DownloadAction({
  connectionId,
  runId,
  revision,
}: Readonly<{ connectionId: string; runId: string; revision: number }>) {
  return (
    <Form
      method="post"
      action={`/account/channels/${encodeURIComponent(connectionId)}/manual-sync/download`}
      spacing="none"
    >
      <HiddenInput name="intent" value="download" />
      <HiddenInput name="runId" value={runId} />
      <HiddenInput name="expectedRevision" value={String(revision)} />
      <Button type="submit">{t("channels.manualSync.action.download")}</Button>
    </Form>
  );
}

function ExportForm({
  surface,
  label,
  submitting,
  onProbe,
}: Readonly<{
  surface: "live" | "staged";
  label: string;
  submitting: boolean;
  onProbe?: (probe: FounderSelectionProbe | null) => void;
}>) {
  const [validSelection, setValidSelection] = useState(false);
  return (
    <RouterForm method="post" encType="multipart/form-data" submitting={submitting}>
      <HiddenInput name="intent" value="ingest" />
      <HiddenInput name="surface" value={surface} />
      <FileDropzone
        name="export"
        accept="text/csv,.csv"
        required
        label={
          surface === "live" ? t("channels.manualSync.file.live.label") : t("channels.manualSync.file.staged.label")
        }
        description={t("channels.manualSync.file.description")}
        dropLabel={t("channels.manualSync.file.drop")}
        browseLabel={t("channels.manualSync.file.choose")}
        onFilesChange={(files) => {
          const file = files?.item(0) ?? null;
          const byteLimit = surface === "live" ? 16_777_216 : 33_554_432;
          setValidSelection(Boolean(file && file.size <= byteLimit));
          if (surface === "live" && onProbe) {
            void probeFounderExportSelection(file).then(
              (probe) => {
                setValidSelection(probe !== null);
                onProbe(probe);
              },
              () => {
                setValidSelection(false);
                onProbe(null);
              },
            );
          }
        }}
      />
      <Button type="submit" disabled={!validSelection}>
        {label}
      </Button>
    </RouterForm>
  );
}

function IngestReceipt({ receipt }: Readonly<{ receipt: ManualSyncIngestReceipt }>) {
  const { probe, outcome } = receipt;
  return (
    <Stack gap={2} data-testid="manual-sync-ingest-receipt">
      {outcome.kind === "ingested" ? (
        <OperationalStatusBanner
          tone="success"
          title={t(
            receipt.surface === "live"
              ? "channels.manualSync.receipt.ingested.live"
              : "channels.manualSync.receipt.ingested.staged",
          )}
          description={t("channels.manualSync.receipt.ingested.description", outcome)}
        />
      ) : (
        <OperationalStatusBanner
          data-testid="manual-sync-ingest-refused"
          tone="danger"
          title={t("channels.manualSync.receipt.refused.title")}
          description={t("channels.manualSync.receipt.refused.description", { reason: outcome.reason })}
        />
      )}
      <KeyValueList
        data-testid="manual-sync-ingest-probe"
        density="compact"
        items={[
          { key: t("channels.manualSync.receipt.fileName"), value: probe.fileName },
          { key: t("channels.manualSync.receipt.byteSize"), value: String(probe.byteSize) },
          { key: t("channels.manualSync.receipt.logicalRows"), value: String(probe.logicalRows) },
          { key: t("channels.manualSync.receipt.headerSha256"), value: probe.headerSha256 },
          { key: t("channels.manualSync.receipt.observedAt"), value: probe.observedAt },
        ]}
      />
    </Stack>
  );
}

function VerifyForm({
  runId,
  revision,
  candidate,
  submitting,
}: Readonly<{
  runId: string;
  revision: number;
  candidate: ManualSyncVerificationCandidate | null;
  submitting: boolean;
}>) {
  if (!candidate) {
    return (
      <OperationalStatusBanner
        data-testid="manual-sync-verify-guidance"
        tone="info"
        title={t("channels.manualSync.verify.none.title")}
        description={t("channels.manualSync.verify.none.description")}
      />
    );
  }
  return (
    <RouterForm method="post" submitting={submitting}>
      <HiddenInput name="intent" value="verify" />
      <HiddenInput name="runId" value={runId} />
      <HiddenInput name="expectedRevision" value={String(revision)} />
      <HiddenInput name="verificationSnapshotId" value={candidate.snapshotId} />
      <KeyValueList
        data-testid="manual-sync-verify-snapshot"
        density="compact"
        items={[
          { key: t("channels.manualSync.verify.snapshot"), value: candidate.snapshotId },
          { key: t("channels.manualSync.verify.capturedAt"), value: candidate.capturedAt },
          { key: t("channels.manualSync.verify.parsedRowCount"), value: String(candidate.parsedRowCount) },
        ]}
      />
      <TextInput name="fileName" label={t("channels.manualSync.verify.fileName")} required />
      <TextInput name="dateImportedText" label={t("channels.manualSync.verify.dateImported")} required />
      <TextInput
        name="numberOfProducts"
        label={t("channels.manualSync.verify.numberOfProducts")}
        inputMode="numeric"
        required
      />
      <Button type="submit">{t("channels.manualSync.action.verify")}</Button>
    </RouterForm>
  );
}

export async function probeFounderExportSelection(file: File | null): Promise<FounderSelectionProbe | null> {
  if (!file || file.size > 16_777_216) return null;
  const observedAt = new Date().toISOString();
  const csv = await file.text();
  const { logicalRows, headerText } = inspectLogicalRecords(csv);
  if (logicalRows > 100_000) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(headerText));
  return {
    fileName: file.name,
    byteSize: file.size,
    logicalRows,
    headerSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    observedAt,
  };
}

function inspectLogicalRecords(csv: string) {
  let quoted = false;
  let records = 0;
  let content = false;
  let headerEnd = csv.length;
  for (let index = 0; index < csv.length; index += 1) {
    if (csv[index] === '"') {
      if (quoted && csv[index + 1] === '"') index += 1;
      else quoted = !quoted;
      content = true;
    } else if (!quoted && (csv[index] === "\r" || csv[index] === "\n")) {
      if (records === 0) headerEnd = index;
      if (csv[index] === "\r" && csv[index + 1] === "\n") index += 1;
      records += 1;
      content = false;
    } else content = true;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (content) records += 1;
  return { logicalRows: Math.max(0, records - 1), headerText: csv.slice(0, headerEnd) };
}

function leaseLabel(milliseconds: number | null) {
  if (milliseconds === null) return t("channels.manualSync.lease.none");
  return t("channels.manualSync.lease.value", {
    minutes: Math.floor(milliseconds / 60_000),
    seconds: Math.floor((milliseconds % 60_000) / 1_000),
  });
}

function stateTone(state: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (state === "applied") return "success";
  if (state === "application-unknown" || state === "stale-basis") return "danger";
  if (state === "validation-rejected" || state === "abandoned") return "warning";
  return "info";
}

function stateLabel(state: string) {
  switch (state) {
    case "composed":
      return t("channels.manualSync.state.composed");
    case "claimed":
      return t("channels.manualSync.state.claimed");
    case "awaiting-verification":
      return t("channels.manualSync.state.awaiting-verification");
    case "applied":
      return t("channels.manualSync.state.applied");
    case "validation-rejected":
      return t("channels.manualSync.state.validation-rejected");
    case "application-unknown":
      return t("channels.manualSync.state.application-unknown");
    case "superseded":
      return t("channels.manualSync.state.superseded");
    case "stale-basis":
      return t("channels.manualSync.state.stale-basis");
    case "abandoned":
      return t("channels.manualSync.state.abandoned");
    default:
      return t("channels.manualSync.state.none");
  }
}
