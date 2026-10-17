import { Banner, Button, DataTable, KeyValueList, Stack, Stat, StatGrid, Text } from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import {
  repricingAnchorWordingCopyKeys,
  repricingClampCopyKeys,
  repricingResultCopyKey,
  resolveRepricingAnchorWording,
} from "./activity-copy";
import { formatRepricingCount, formatRepricingMoney } from "./policy-copy";
import { editorCopy } from "./policy-controls-fields";

export function DryRunResult({
  run,
  traces,
  samplesLoading = false,
  samplesFailed = false,
  onNext,
}: {
  run: RepricingDryRun;
  traces: readonly RepricingPolicyListingTrace[];
  samplesLoading?: boolean;
  samplesFailed?: boolean;
  onNext?: (after?: string) => void;
}) {
  if (run.status === "failed") return <Banner tone="danger" title={editorCopy("preview.failed")} />;
  if (run.status !== "completed" || !run.summary) return <Banner tone="info" title={editorCopy("preview.running")} />;
  const summary = run.summary;
  return (
    <Stack gap={4} data-testid="repricing-dry-run-result">
      <Text>
        {t("pricing.features.repricingPolicies.ui.editor.preview.completed", {
          time: formatDateTime(run.completedAt ?? run.updatedAt),
          count: formatRepricingCount(summary.listingsEvaluated),
        })}
      </Text>
      {summary.listingsEvaluated === 0 ? <Banner tone="info" title={editorCopy("preview.empty")} /> : null}
      <StatGrid>
        <Stat label={editorCopy("preview.evaluated")} value={formatRepricingCount(summary.listingsEvaluated)} />
        <Stat label={editorCopy("preview.changed")} value={formatRepricingCount(summary.outcomes.changed ?? 0)} />
        <Stat label={editorCopy("preview.tolerance")} value={formatRepricingCount(summary.withinTolerance)} />
      </StatGrid>
      <KeyValueList
        items={[
          ...(["floor", "ceiling", "maxMove"] as const).map((key) => ({
            key: t(repricingClampCopyKeys[key]),
            value: formatRepricingCount(summary.flags[key === "maxMove" ? "max-move-binding" : `${key}-binding`] ?? 0),
          })),
          { key: editorCopy("preview.paused"), value: formatRepricingCount(summary.outcomes["pause-requested"] ?? 0) },
          { key: editorCopy("preview.notified"), value: formatRepricingCount(summary.outcomes["notify-only"] ?? 0) },
          { key: editorCopy("preview.held"), value: formatRepricingCount(summary.skipReasons["terminal-hold"] ?? 0) },
        ]}
      />
      <DataTable
        caption={editorCopy("preview.buckets")}
        rows={Array.from({ length: 9 }, (_, bucket) => ({ bucket, count: summary.deltaBuckets[String(bucket)] ?? 0 }))}
        getRowId={(row) => String(row.bucket)}
        columns={[
          { key: "bucket", header: editorCopy("preview.delta"), cell: (row) => editorCopy(`bucket.${row.bucket}`) },
          { key: "count", header: editorCopy("preview.count"), cell: (row) => formatRepricingCount(row.count) },
        ]}
      />
      {samplesFailed ? (
        <Banner
          tone="danger"
          title={editorCopy("preview.samplesFailed")}
          actions={<Button onClick={() => onNext?.()}>{editorCopy("retry")}</Button>}
        />
      ) : null}
      <DataTable
        caption={editorCopy("preview.samples")}
        rows={[...traces]}
        loading={samplesLoading}
        getRowId={(trace) => trace.listingId}
        columns={[
          { key: "listing", header: editorCopy("preview.listing"), cell: (trace) => trace.listingId },
          { key: "result", header: editorCopy("preview.result"), cell: (trace) => t(repricingResultCopyKey(trace)) },
          {
            key: "anchor",
            header: editorCopy("anchor"),
            cell: (trace) => {
              const wording = resolveRepricingAnchorWording(trace);
              return wording ? t(repricingAnchorWordingCopyKeys[wording]) : editorCopy("mode.none");
            },
          },
          {
            key: "price",
            header: editorCopy("preview.price"),
            cell: (trace) =>
              formatRepricingMoney(
                trace.targetPriceAmount ?? trace.currentPriceAmount,
                run.body.rules[trace.ruleIndex]?.directive.currencyCode,
              ),
          },
          {
            key: "clamps",
            header: editorCopy("preview.clamps"),
            cell: (trace) =>
              (Object.keys(repricingClampCopyKeys) as (keyof typeof repricingClampCopyKeys)[])
                .filter((key) => trace.clamps[key])
                .map((key) => t(repricingClampCopyKeys[key]))
                .join(", "),
          },
        ]}
      />
      {traces.length === 100 && onNext ? (
        <Button disabled={samplesLoading} onClick={() => onNext(traces.at(-1)!.listingId)}>
          {editorCopy("preview.more")}
        </Button>
      ) : null}
    </Stack>
  );
}
