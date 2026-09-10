import { useState } from "react";
import {
  Badge,
  Button,
  FileDropzone,
  Form,
  HiddenInput,
  Inline,
  MetricStrip,
  OperationalStatusBanner,
  Stack,
  TextInput,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ManualSyncActionId, ManualSyncPanel } from "../domain/contracts";

export type FounderSelectionProbe = Readonly<{
  fileName: string;
  byteSize: number;
  logicalRows: number;
  headerSha256: string;
  observedAt: string;
}>;

export function ManualSyncPanelView({ panel }: Readonly<{ panel: ManualSyncPanel }>) {
  const [selectionProbe, setSelectionProbe] = useState<FounderSelectionProbe | null>(null);
  const run = panel.run;
  const state = run?.state ?? "none";
  return (
    <WorkflowModule
      data-testid="manual-sync-panel"
      title={t("channels.manualSync.title")}
      description={t("channels.manualSync.description")}
      status={<Badge tone={stateTone(state)}>{stateLabel(state)}</Badge>}
    >
      <OperationalStatusBanner
        tone="warning"
        title={t("channels.manualSync.coverage.dark")}
        description={t("channels.manualSync.coverage.dark.description")}
      />
      <MetricStrip
        items={[
          { label: t("channels.manualSync.metric.requested"), value: String(panel.requestedListingCount) },
          { label: t("channels.manualSync.metric.composed"), value: String(panel.composedListingCount) },
          { label: t("channels.manualSync.metric.lease"), value: leaseLabel(panel.leaseCountdownMs) },
        ]}
      />
      <Inline gap={2} wrap>
        {panel.actions.includes("compose") ? (
          <EmptyAction intent="compose" labelKey="channels.manualSync.action.compose" />
        ) : null}
        {panel.actions.includes("download") && run ? (
          <RunAction
            intent="download"
            labelKey="channels.manualSync.action.download"
            runId={run.runId}
            revision={run.revision}
          />
        ) : null}
        {panel.actions.includes("record-validation-cancellation") && run ? (
          <RunAction
            intent="validation-cancelled"
            labelKey="channels.manualSync.action.cancel"
            runId={run.runId}
            revision={run.revision}
          />
        ) : null}
        {panel.actions.includes("release") && run ? (
          <RunAction
            intent="release"
            labelKey="channels.manualSync.action.release"
            runId={run.runId}
            revision={run.revision}
          />
        ) : null}
      </Inline>
      {panel.actions.includes("record-upload-attempt") && run ? (
        <Form method="post">
          <HiddenInput name="intent" value="upload-attempt" />
          <HiddenInput name="runId" value={run.runId} />
          <HiddenInput name="expectedRevision" value={String(run.revision)} />
          <TextInput name="fileName" label={t("channels.manualSync.file.staged.label")} required />
          <Button type="submit">{t("channels.manualSync.action.uploadAttempt")}</Button>
        </Form>
      ) : null}
      {panel.actions.includes("ingest-live") ? (
        <ExportForm surface="live" label={t("channels.manualSync.action.ingestLive")} onProbe={setSelectionProbe} />
      ) : null}
      {panel.actions.includes("ingest-staged") ? (
        <ExportForm surface="staged" label={t("channels.manualSync.action.ingestStaged")} />
      ) : null}
      {selectionProbe ? (
        <OperationalStatusBanner
          data-testid="founder-export-selection-probe"
          tone="info"
          title={t("channels.manualSync.probe.summary", selectionProbe)}
          description={t("channels.manualSync.probe.detail", selectionProbe)}
        />
      ) : null}
      {panel.actions.includes("verify") && run ? <VerifyForm runId={run.runId} revision={run.revision} /> : null}
    </WorkflowModule>
  );
}

function EmptyAction({ intent, labelKey }: Readonly<{ intent: string; labelKey: Parameters<typeof t>[0] }>) {
  return (
    <Form method="post" spacing="none">
      <HiddenInput name="intent" value={intent} />
      <Button type="submit">{t(labelKey)}</Button>
    </Form>
  );
}

function RunAction({
  intent,
  labelKey,
  runId,
  revision,
}: Readonly<{
  intent: string;
  labelKey: Parameters<typeof t>[0];
  runId: string;
  revision: number;
}>) {
  return (
    <Form method="post" spacing="none">
      <HiddenInput name="intent" value={intent} />
      <HiddenInput name="runId" value={runId} />
      <HiddenInput name="expectedRevision" value={String(revision)} />
      <Button type="submit">{t(labelKey)}</Button>
    </Form>
  );
}

function ExportForm({
  surface,
  label,
  onProbe,
}: Readonly<{
  surface: "live" | "staged";
  label: string;
  onProbe?: (probe: FounderSelectionProbe | null) => void;
}>) {
  const [validSelection, setValidSelection] = useState(false);
  return (
    <Form method="post" encType="multipart/form-data">
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
    </Form>
  );
}

function VerifyForm({ runId, revision }: Readonly<{ runId: string; revision: number }>) {
  return (
    <Form method="post">
      <HiddenInput name="intent" value="verify" />
      <HiddenInput name="runId" value={runId} />
      <HiddenInput name="expectedRevision" value={String(revision)} />
      <TextInput name="verificationSnapshotId" label={t("channels.manualSync.verify.snapshot")} required />
      <TextInput name="fileName" label={t("channels.manualSync.verify.fileName")} required />
      <TextInput name="dateImportedText" label={t("channels.manualSync.verify.dateImported")} required />
      <TextInput
        name="numberOfProducts"
        label={t("channels.manualSync.verify.numberOfProducts")}
        inputMode="numeric"
        required
      />
      <Button type="submit">{t("channels.manualSync.action.verify")}</Button>
    </Form>
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
