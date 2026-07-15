import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { t } from "@chase-sets/localization";
import {
  Button,
  ConnectionStatusIndicator,
  FileDropzone,
  Form,
  Grid,
  HiddenInput,
  NativeSelect,
  OperationalStatusBanner,
  Page,
  PageHeader,
  Stack,
  Stat,
  StatGrid,
  Table,
  TaskScanInput,
  TaskSummary,
  Text,
  TextInput,
  Textarea,
  WorkflowModule,
  WorkstationLayout,
} from "@chase-sets/design-system";
import type {
  OperatorReturnShipmentView,
  ReturnIntakeMetrics,
  UnidentifiedReturnPackageView,
} from "../read-model/queries";

export type FacilityIntakePageProps = Readonly<{
  facilityId: string;
  queue: readonly OperatorReturnShipmentView[];
  unidentified: readonly UnidentifiedReturnPackageView[];
  metrics: ReturnIntakeMetrics;
  resolved: OperatorReturnShipmentView | null;
  expectedVersion: number | null;
  formToken: string;
  actionError: string | null;
  actionResult: "completed" | "duplicate" | "unidentified" | "reconciled" | "corrected" | null;
  submitting: boolean;
}>;

const discrepancyItems = [
  { value: "expected", label: t("fulfillment.returnIntake.discrepancy.expected") },
  { value: "missing", label: t("fulfillment.returnIntake.discrepancy.missing") },
  { value: "extra", label: t("fulfillment.returnIntake.discrepancy.extra") },
  { value: "substituted", label: t("fulfillment.returnIntake.discrepancy.substituted") },
  { value: "damaged", label: t("fulfillment.returnIntake.discrepancy.damaged") },
  { value: "empty-package", label: t("fulfillment.returnIntake.discrepancy.emptyPackage") },
  { value: "unreadable", label: t("fulfillment.returnIntake.discrepancy.unreadable") },
];

const packageConditionItems = [
  { value: "intact", label: t("fulfillment.returnIntake.condition.intact") },
  { value: "damaged", label: t("fulfillment.returnIntake.condition.damaged") },
  { value: "opened", label: t("fulfillment.returnIntake.condition.opened") },
  { value: "empty", label: t("fulfillment.returnIntake.condition.empty") },
  { value: "unreadable", label: t("fulfillment.returnIntake.condition.unreadable") },
];

const sealConditionItems = [
  { value: "intact", label: t("fulfillment.returnIntake.condition.intact") },
  { value: "broken", label: t("fulfillment.returnIntake.condition.broken") },
  { value: "missing", label: t("fulfillment.returnIntake.condition.missing") },
  { value: "not-applicable", label: t("fulfillment.returnIntake.condition.notApplicable") },
  { value: "unreadable", label: t("fulfillment.returnIntake.condition.unreadable") },
];

const dispositionItems = [
  { value: "completed", label: t("fulfillment.returnIntake.disposition.complete") },
  { value: "quarantine", label: t("fulfillment.returnIntake.disposition.quarantine") },
  { value: "manual-review", label: t("fulfillment.returnIntake.disposition.manualReview") },
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function destinationInstructions(shipment: OperatorReturnShipmentView): string {
  const destination = shipment.destination_snapshot as { displayInstructions?: string } | null;
  return destination?.displayInstructions ?? t("fulfillment.returnIntake.safeHandlingFallback");
}

function packageSummary(shipment: OperatorReturnShipmentView): string {
  const requirements = shipment.package_requirements as Record<string, unknown> | null;
  if (!requirements) return t("fulfillment.returnIntake.noPackageMeasurements");
  return `${requirements.weightOunces ?? "—"} oz · ${requirements.lengthInches ?? "—"} × ${requirements.widthInches ?? "—"} × ${requirements.heightInches ?? "—"} in`;
}

function expectedItemSummary(shipment: OperatorReturnShipmentView): string {
  if (!shipment.expected_items?.length) return t("fulfillment.returnIntake.noItemSummary");
  return shipment.expected_items.map((item) => `${item.item_title} × ${item.quantity}`).join("; ");
}

function facilityIntakeSummary(shipment: OperatorReturnShipmentView): {
  custodyIdentifier: string;
  disposition: string;
} | null {
  if (!shipment.facility_intake || typeof shipment.facility_intake !== "object") return null;
  const intake = shipment.facility_intake as Record<string, unknown>;
  return {
    custodyIdentifier: String(intake.custodyIdentifier ?? t("fulfillment.returnIntake.notAssigned")),
    disposition: String(intake.disposition ?? "completed"),
  };
}

export function FacilityIntakePage(props: FacilityIntakePageProps) {
  const navigate = useNavigate();
  const [scanValue, setScanValue] = useState("");
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  function resolveScan(identifier: string) {
    const params = new URLSearchParams({ facilityId: props.facilityId, identifier: identifier.trim() });
    navigate(`/return-intake?${params.toString()}`);
  }

  const intakeSummary = props.resolved ? facilityIntakeSummary(props.resolved) : null;
  const alreadyCompleted = intakeSummary !== null;
  const requiresReview = intakeSummary?.disposition === "quarantine" || intakeSummary?.disposition === "manual-review";
  const statusMessage =
    props.actionResult === "duplicate"
      ? t("fulfillment.returnIntake.status.duplicate")
      : props.actionResult === "completed"
        ? t("fulfillment.returnIntake.status.completed")
        : props.actionResult === "unidentified"
          ? t("fulfillment.returnIntake.status.unidentified")
          : props.actionResult === "reconciled"
            ? t("fulfillment.returnIntake.status.reconciled")
            : props.actionResult === "corrected"
              ? t("fulfillment.returnIntake.status.corrected")
              : null;

  return (
    <Page width="expanded">
      <PageHeader
        eyebrow={t("fulfillment.returnIntake.eyebrow")}
        title={t("fulfillment.returnIntake.title")}
        description={t("fulfillment.returnIntake.description")}
        actions={
          <ConnectionStatusIndicator
            status={online ? "live" : "stale"}
            liveLabel={t("fulfillment.returnIntake.online")}
            staleLabel={t("fulfillment.returnIntake.offline")}
            staleDescription={t("fulfillment.returnIntake.offlineDescription")}
            action={<Button onClick={() => window.location.reload()}>{t("fulfillment.returnIntake.retry")}</Button>}
          />
        }
      />

      {props.actionError ? (
        <OperationalStatusBanner
          tone="danger"
          title={t("fulfillment.returnIntake.notSaved")}
          description={props.actionError}
          action={
            <Button onClick={() => window.location.reload()}>{t("fulfillment.returnIntake.reloadCurrentState")}</Button>
          }
        />
      ) : null}
      {statusMessage ? <OperationalStatusBanner tone="success" title={statusMessage} /> : null}

      {!props.facilityId ? (
        <WorkflowModule
          title={t("fulfillment.returnIntake.chooseFacility")}
          description={t("fulfillment.returnIntake.chooseFacilityDescription")}
        >
          <Form method="get" spacing="sm">
            <TextInput name="facilityId" label={t("fulfillment.returnIntake.facilityIdentifier")} required autoFocus />
            <Button type="submit">{t("fulfillment.returnIntake.openFacilityStation")}</Button>
          </Form>
        </WorkflowModule>
      ) : null}

      <TaskScanInput
        autoFocus={Boolean(props.facilityId)}
        label={t("fulfillment.returnIntake.scanLabel")}
        description={t("fulfillment.returnIntake.scanDescription")}
        placeholder={t("fulfillment.returnIntake.scanPlaceholder")}
        buttonLabel={t("fulfillment.returnIntake.resolvePackage")}
        value={scanValue}
        onValueChange={setScanValue}
        onSubmit={resolveScan}
        disabled={!props.facilityId || !online || props.submitting}
      />

      <StatGrid columns={{ base: 1, sm: 2, lg: 4 }}>
        <Stat
          label={t("fulfillment.returnIntake.metric.deliveredNotIntaken")}
          value={props.metrics.delivered_not_intaken_count}
        />
        <Stat
          label={t("fulfillment.returnIntake.metric.oldestWaiting")}
          value={formatDuration(props.metrics.oldest_delivered_not_intaken_age_seconds)}
        />
        <Stat
          label={t("fulfillment.returnIntake.metric.discrepancyRate")}
          value={`${Math.round(props.metrics.discrepancy_rate * 100)}%`}
        />
        <Stat
          label={t("fulfillment.returnIntake.metric.unidentified")}
          value={props.metrics.unidentified_package_count}
        />
        <Stat label={t("fulfillment.returnIntake.metric.duplicateScans")} value={props.metrics.duplicate_scan_count} />
        <Stat
          label={t("fulfillment.returnIntake.metric.averageLatency")}
          value={formatDuration(props.metrics.average_intake_latency_seconds)}
        />
      </StatGrid>

      {props.resolved ? (
        <WorkstationLayout
          secondaryTitle={t("fulfillment.returnIntake.expectedPackage")}
          secondaryDescription={t("fulfillment.returnIntake.expectedPackageDescription")}
          secondary={
            <Stack gap={3}>
              <TaskSummary
                title={t("fulfillment.returnIntake.expectedPackage")}
                items={[
                  { label: t("fulfillment.returnIntake.returnShipment"), value: props.resolved.return_shipment_id },
                  {
                    label: t("fulfillment.returnIntake.tracking"),
                    value: props.resolved.tracking_identifier ?? t("fulfillment.returnIntake.notAvailable"),
                  },
                  { label: t("fulfillment.returnIntake.order"), value: props.resolved.order_id },
                  { label: t("fulfillment.returnIntake.expectedItems"), value: expectedItemSummary(props.resolved) },
                  { label: t("fulfillment.returnIntake.package"), value: packageSummary(props.resolved) },
                  { label: t("fulfillment.returnIntake.safeHandling"), value: destinationInstructions(props.resolved) },
                  {
                    label: t("fulfillment.returnIntake.carrierDelivered"),
                    value: props.resolved.delivered_at ?? t("fulfillment.returnIntake.notRecorded"),
                  },
                  {
                    label: t("fulfillment.returnIntake.facilityIntake"),
                    value: props.resolved.received_at ?? t("fulfillment.returnIntake.notCompleted"),
                  },
                  ...(intakeSummary
                    ? [
                        { label: t("fulfillment.returnIntake.disposition"), value: intakeSummary.disposition },
                        {
                          label: t("fulfillment.returnIntake.custodyIdentifier"),
                          value: intakeSummary.custodyIdentifier,
                        },
                      ]
                    : []),
                ]}
              />
              {alreadyCompleted ? (
                <Button tone="secondary" onClick={() => window.print()}>
                  {t("fulfillment.returnIntake.printCustodyIdentifier")}
                </Button>
              ) : null}
            </Stack>
          }
          primary={
            alreadyCompleted ? (
              <WorkflowModule
                title={t("fulfillment.returnIntake.existingResult")}
                description={t("fulfillment.returnIntake.existingResultDescription")}
                status={
                  requiresReview
                    ? t("fulfillment.returnIntake.exceptionRouted")
                    : t("fulfillment.returnIntake.complete")
                }
              >
                <OperationalStatusBanner
                  tone={requiresReview ? "warning" : "info"}
                  title={
                    requiresReview
                      ? t("fulfillment.returnIntake.routedTo", { disposition: intakeSummary.disposition })
                      : t("fulfillment.returnIntake.doubleScanPrevention")
                  }
                  description={t("fulfillment.returnIntake.duplicateDescription")}
                />
                <Form method="post" spacing="md" submitting={props.submitting}>
                  <HiddenInput name="intent" value="correct" />
                  <HiddenInput name="facilityId" value={props.facilityId} />
                  <HiddenInput name="returnShipmentId" value={props.resolved.return_shipment_id} />
                  <HiddenInput name="expectedVersion" value={props.expectedVersion ?? ""} />
                  <Textarea name="reason" label={t("fulfillment.returnIntake.correctionReason")} required />
                  <TextInput name="owner" label={t("fulfillment.returnIntake.correctedOwner")} />
                  <TextInput name="nextAction" label={t("fulfillment.returnIntake.correctedNextAction")} />
                  <TextInput
                    name="custodyIdentifier"
                    label={t("fulfillment.returnIntake.correctedCustodyIdentifier")}
                  />
                  <Button type="submit" disabled={!online}>
                    {t("fulfillment.returnIntake.recordCorrection")}
                  </Button>
                </Form>
              </WorkflowModule>
            ) : (
              <WorkflowModule
                title={t("fulfillment.returnIntake.recordCustody")}
                description={t("fulfillment.returnIntake.recordCustodyDescription")}
              >
                <Form
                  method="post"
                  encType="multipart/form-data"
                  spacing="lg"
                  submitting={props.submitting}
                  disabled={!online}
                  validationSummaryId="intake-help"
                >
                  <HiddenInput name="intent" value="complete" />
                  <HiddenInput name="returnShipmentId" value={props.resolved.return_shipment_id} />
                  <HiddenInput name="facilityId" value={props.facilityId} />
                  <HiddenInput name="expectedVersion" value={props.expectedVersion ?? ""} />
                  <HiddenInput name="idempotencyKey" value={props.formToken} />
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <TextInput
                      name="stationId"
                      label={t("fulfillment.returnIntake.facilityStation")}
                      required
                      autoComplete="off"
                    />
                    <TextInput
                      name="receivedAt"
                      type="datetime-local"
                      label={t("fulfillment.returnIntake.receiptTimestamp")}
                      required
                    />
                    <NativeSelect
                      name="packageCondition"
                      label={t("fulfillment.returnIntake.packageCondition")}
                      items={packageConditionItems}
                      required
                    />
                    <NativeSelect
                      name="sealCondition"
                      label={t("fulfillment.returnIntake.sealCondition")}
                      items={sealConditionItems}
                      required
                    />
                    <TextInput
                      name="measuredWeightOunces"
                      type="number"
                      min="0.1"
                      step="0.1"
                      label={t("fulfillment.returnIntake.measuredWeight")}
                    />
                    <TextInput
                      name="custodyIdentifier"
                      label={t("fulfillment.returnIntake.internalCustodyIdentifier")}
                      required
                      autoComplete="off"
                    />
                  </Grid>
                  <FileDropzone
                    name="evidence"
                    label={t("fulfillment.returnIntake.custodyEvidence")}
                    description={t("fulfillment.returnIntake.evidenceDescription")}
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    multiple
                    required
                  />
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <NativeSelect
                      name="discrepancyType"
                      label={t("fulfillment.returnIntake.observedState")}
                      items={discrepancyItems}
                      required
                    />
                    <NativeSelect
                      name="disposition"
                      label={t("fulfillment.returnIntake.disposition")}
                      items={dispositionItems}
                      required
                    />
                    <TextInput
                      name="expectedItemReference"
                      label={t("fulfillment.returnIntake.expectedItemReference")}
                    />
                    <TextInput
                      name="observedItemReference"
                      label={t("fulfillment.returnIntake.observedItemReference")}
                    />
                    <TextInput
                      name="quantity"
                      type="number"
                      min="1"
                      step="1"
                      defaultValue="1"
                      label={t("fulfillment.returnIntake.quantity")}
                      required
                    />
                    <TextInput
                      name="owner"
                      label={t("fulfillment.returnIntake.owner")}
                      defaultValue={t("fulfillment.returnIntake.eyebrow")}
                      required
                    />
                  </Grid>
                  <TextInput
                    name="nextAction"
                    label={t("fulfillment.returnIntake.nextAction")}
                    defaultValue={t("fulfillment.returnIntake.completeCustodyHandoff")}
                    required
                  />
                  <Textarea name="notes" label={t("fulfillment.returnIntake.conditionNotes")} />
                  <Text id="intake-help" role="note" tone="secondary" size="sm">
                    {t("fulfillment.returnIntake.physicalTruthReminder")}
                  </Text>
                  <Button type="submit" loading={props.submitting} disabled={!online}>
                    {t("fulfillment.returnIntake.completeFacilityIntake")}
                  </Button>
                </Form>
              </WorkflowModule>
            )
          }
        />
      ) : (
        <WorkflowModule
          title={t("fulfillment.returnIntake.unidentifiedException")}
          description={t("fulfillment.returnIntake.unidentifiedExceptionDescription")}
        >
          <Form
            method="post"
            encType="multipart/form-data"
            spacing="md"
            submitting={props.submitting}
            disabled={!online}
          >
            <HiddenInput name="intent" value="unidentified" />
            <HiddenInput name="facilityId" value={props.facilityId} />
            <HiddenInput name="idempotencyKey" value={props.formToken} />
            <Grid columns={{ base: 1, md: 2 }} gap={3}>
              <TextInput name="stationId" label={t("fulfillment.returnIntake.facilityStation")} required />
              <TextInput
                name="receivedAt"
                type="datetime-local"
                label={t("fulfillment.returnIntake.receiptTimestamp")}
                required
              />
              <NativeSelect
                name="packageCondition"
                label={t("fulfillment.returnIntake.packageCondition")}
                items={packageConditionItems}
                required
              />
              <NativeSelect
                name="sealCondition"
                label={t("fulfillment.returnIntake.sealCondition")}
                items={sealConditionItems}
                required
              />
              <TextInput
                name="measuredWeightOunces"
                type="number"
                min="0.1"
                step="0.1"
                label={t("fulfillment.returnIntake.measuredWeight")}
              />
              <TextInput
                name="custodyIdentifier"
                label={t("fulfillment.returnIntake.internalCustodyIdentifier")}
                required
              />
              <TextInput
                name="owner"
                label={t("fulfillment.returnIntake.exceptionOwner")}
                defaultValue={t("fulfillment.returnIntake.eyebrow")}
                required
              />
            </Grid>
            <FileDropzone
              name="evidence"
              label={t("fulfillment.returnIntake.packageEvidence")}
              description={t("fulfillment.returnIntake.packageEvidenceDescription")}
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              multiple
              required
            />
            <Textarea name="notes" label={t("fulfillment.returnIntake.identificationNotes")} />
            <TextInput
              name="nextAction"
              label={t("fulfillment.returnIntake.nextAction")}
              defaultValue={t("fulfillment.returnIntake.holdForReview")}
              required
            />
            <Button type="submit" loading={props.submitting} disabled={!online}>
              {t("fulfillment.returnIntake.recordUnidentified")}
            </Button>
          </Form>
        </WorkflowModule>
      )}

      <WorkflowModule
        title={t("fulfillment.returnIntake.queue")}
        description={t("fulfillment.returnIntake.queueDescription")}
      >
        <Table
          caption={t("fulfillment.returnIntake.queueCaption")}
          columns={[
            t("fulfillment.returnIntake.returnShipment"),
            t("fulfillment.returnIntake.tracking"),
            t("fulfillment.returnIntake.status"),
            t("fulfillment.returnIntake.delivered"),
            t("fulfillment.returnIntake.received"),
          ]}
          rows={props.queue.map((item) => [
            item.return_shipment_id,
            item.tracking_identifier ?? "—",
            item.status,
            item.delivered_at ?? "—",
            item.received_at ?? "—",
          ])}
        />
      </WorkflowModule>

      <WorkflowModule
        title={t("fulfillment.returnIntake.unidentifiedPackages")}
        description={t("fulfillment.returnIntake.unidentifiedDescription")}
      >
        <Table
          caption={t("fulfillment.returnIntake.unidentifiedCaption")}
          columns={[
            t("fulfillment.returnIntake.custodyIdentifier"),
            t("fulfillment.returnIntake.received"),
            t("fulfillment.returnIntake.condition"),
            t("fulfillment.returnIntake.reconciledReturnShipment"),
            t("fulfillment.returnIntake.reconcile"),
          ]}
          rows={props.unidentified.map((item) => [
            item.custody_identifier,
            item.received_at,
            item.package_condition,
            item.return_shipment_id ?? t("fulfillment.returnIntake.awaitingReconciliation"),
            item.return_shipment_id ? (
              t("fulfillment.returnIntake.complete")
            ) : (
              <Form method="post" spacing="sm">
                <HiddenInput name="intent" value="reconcile" />
                <HiddenInput name="facilityId" value={props.facilityId} />
                <HiddenInput name="unidentifiedPackageId" value={item.unidentified_package_id} />
                <TextInput name="returnShipmentId" label={t("fulfillment.returnIntake.returnShipment")} required />
                <TextInput name="reason" label={t("fulfillment.returnIntake.reason")} required />
                <Button type="submit" tone="secondary">
                  {t("fulfillment.returnIntake.reconcile")}
                </Button>
              </Form>
            ),
          ])}
        />
      </WorkflowModule>
    </Page>
  );
}
