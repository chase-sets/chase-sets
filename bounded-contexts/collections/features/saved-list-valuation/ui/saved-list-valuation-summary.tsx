import { Badge, Stack, Stat, StatGrid, Surface, Text } from "@chase-sets/design-system";
import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import type { SavedListValuationSummary as SavedListValuationSummaryContract } from "../domain/contracts";

export type SavedListValuationSummaryProps = Readonly<{
  valuation: SavedListValuationSummaryContract;
}>;

export function SavedListValuationSummary({ valuation }: SavedListValuationSummaryProps) {
  const { coverage } = valuation;
  const estimate = valuation.estimatedTotalAmount
    ? formatMoney(valuation.estimatedTotalAmount, valuation.currencyCode)
    : t("collections.features.savedListValuation.ui.unavailable");
  const band = valuation.estimatedTotalBand
    ? t("collections.features.savedListValuation.ui.band", {
        low: formatMoney(valuation.estimatedTotalBand.lowAmount, valuation.currencyCode),
        high: formatMoney(valuation.estimatedTotalBand.highAmount, valuation.currencyCode),
      })
    : null;

  return (
    <Surface padding={6}>
      <Stack gap={4}>
        <StatGrid columns={{ base: 1, sm: 3 }}>
          <Stat
            label={t("collections.features.savedListValuation.ui.estimatedMarketValue")}
            value={estimate}
            trend={band}
          />
          <Stat
            label={t("collections.features.savedListValuation.ui.lineCoverage")}
            value={t("collections.features.savedListValuation.ui.coverage", {
              priced: coverage.priced.lines,
              total: coverage.total.lines,
            })}
          />
          <Stat
            label={t("collections.features.savedListValuation.ui.unitCoverage")}
            value={t("collections.features.savedListValuation.ui.coverage", {
              priced: coverage.priced.units,
              total: coverage.total.units,
            })}
          />
        </StatGrid>

        <Stack direction={{ base: "column", sm: "row" }} gap={2}>
          {coverage.missing.lines > 0 ? (
            <Badge tone="neutral">
              {t("collections.features.savedListValuation.ui.missing", { count: coverage.missing.lines })}
            </Badge>
          ) : null}
          {coverage.stale.lines > 0 ? (
            <Badge tone="warning">
              {t("collections.features.savedListValuation.ui.stale", { count: coverage.stale.lines })}
            </Badge>
          ) : null}
          {coverage.lowConfidence.lines > 0 ? (
            <Badge tone="info">
              {t("collections.features.savedListValuation.ui.lowConfidence", {
                count: coverage.lowConfidence.lines,
              })}
            </Badge>
          ) : null}
        </Stack>

        <Text size="sm" tone="secondary">
          {valuation.estimateAsOf
            ? t("collections.features.savedListValuation.ui.asOf", {
                date: formatDateTime(valuation.estimateAsOf),
              })
            : t("collections.features.savedListValuation.ui.noCurrentEstimates")}
        </Text>
        <Text size="sm" tone="secondary">
          {t("collections.features.savedListValuation.ui.disclaimer")}
        </Text>
      </Stack>
    </Surface>
  );
}
