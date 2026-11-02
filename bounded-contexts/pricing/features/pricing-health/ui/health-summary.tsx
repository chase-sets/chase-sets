import { formatDateTime, formatMoney } from "@chase-sets/localization";
import { Badge, Banner, Card, KeyValueList, Stack, Text } from "@chase-sets/design-system";
import type { RepricingHealthSummary } from "../../repricing-engine/api/health-summary";
import type { PricingHealthRun } from "../read-model/queries";
import { healthCopy as copy, healthNumber as number, healthPercent as percent, healthReasonLabel } from "./copy";

function Reasons({ values }: Readonly<{ values: Readonly<Record<string, number>> }>) {
  const entries = Object.entries(values);
  return entries.length === 0 ? (
    copy("none")
  ) : (
    <KeyValueList
      items={entries.map(([reason, count]) => ({ key: healthReasonLabel(reason), value: number(count) }))}
    />
  );
}

export function HealthSummary({
  health,
  run,
}: Readonly<{ health: RepricingHealthSummary; run: PricingHealthRun | null }>) {
  return (
    <Stack gap={4} data-testid="pricing-health-summary">
      <Banner tone="info" title={copy("snapshot.title")} description={copy("snapshot.description")} />
      <KeyValueList
        items={[
          { key: copy("capturedAt"), value: formatDateTime(health.capturedAt) },
          {
            key: copy("population"),
            value: copy("population.value", {
              listings: number(health.population.listingCount),
              units: number(health.population.unitCount),
            }),
          },
          { key: copy("run"), value: run?.dryRunId ?? copy("unavailable") },
          { key: copy("revision"), value: run?.bodyHash ?? copy("unavailable") },
          { key: copy("completedAt"), value: run ? formatDateTime(run.completedAt) : copy("unavailable") },
          {
            key: copy("uncategorized"),
            value: copy("population.value", {
              listings: number(health.uncategorized.listingCount),
              units: number(health.uncategorized.unitCount),
            }),
          },
          { key: copy("reasons"), value: <Reasons values={health.uncategorized.reasons} /> },
        ]}
      />
      {health.population.listingCount === 0 ? <Banner tone="info" title={copy("emptyPopulation")} /> : null}
      {Object.entries(health.currencies).map(([currency, summary]) => {
        const money = (amount: string) => formatMoney(amount, currency);
        const risk = (kind: "hopeless" | "slow") =>
          copy("risk.value", {
            listings: number(summary.valueAtRisk[kind].listingCount),
            units: number(summary.valueAtRisk[kind].unitCount),
            value: money(summary.valueAtRisk[kind].valueAmount),
          });
        return (
          <Card
            key={currency}
            elevation="tinted"
            data-elevation-role="furniture"
            data-testid={`pricing-health-${currency}`}
          >
            <Card.Header>
              <Card.Title>{currency}</Card.Title>
              <Card.Description>{copy("currency.description")}</Card.Description>
            </Card.Header>
            <Card.Body>
              {summary.coverage.listingCount === 0 ? <Banner tone="info" title={copy("noModeled")} /> : null}
              <Badge tone={summary.curveAge.staleCount > 0 ? "warning" : "neutral"}>
                {copy(summary.curveAge.staleCount > 0 ? "stale" : "freshAtCapture")}
              </Badge>
              <KeyValueList
                items={[
                  { key: copy("s1"), value: money(summary.listedValueAmount) },
                  {
                    key: copy("s2"),
                    value: (
                      <Text element="span" size="sm" tone="inherit" data-testid="health-s2">
                        {money(summary.modeledValueAmount)}
                      </Text>
                    ),
                  },
                  { key: copy("delta"), value: money(summary.modeledValueDeltaAmount) },
                  {
                    key: copy("s3"),
                    value: copy("coverage.value", {
                      modeled: number(summary.coverage.listingCount),
                      population: number(summary.coverage.listingTotal),
                      modeledUnits: number(summary.coverage.unitCount),
                      units: number(summary.coverage.unitTotal),
                      listingShare: percent(summary.coverage.listingRatio),
                      unitShare: percent(summary.coverage.unitRatio),
                    }),
                  },
                  { key: copy("reasons"), value: <Reasons values={summary.coverage.missingReasons} /> },
                  { key: copy("bounds"), value: number(summary.coverage.boundStatusCount) },
                  {
                    key: copy("s4"),
                    value: copy("age.value", {
                      newest: number(summary.curveAge.newestAgeDays),
                      oldest: number(summary.curveAge.oldestAgeDays),
                      stale: number(summary.curveAge.staleCount),
                    }),
                  },
                  {
                    key: copy("s5"),
                    value: copy("wait.value", {
                      median: number(summary.expectedWait.medianDays),
                      p90: number(summary.expectedWait.p90Days),
                    }),
                  },
                  {
                    key: copy("s6"),
                    value: (
                      <Text element="span" size="sm" tone="inherit" data-testid="health-s6">
                        {copy("sales.value", {
                          listings: number(summary.expectedSales.listingCount),
                          value: money(summary.expectedSales.valueAmount),
                        })}
                      </Text>
                    ),
                  },
                  { key: copy("s7.hopeless"), value: risk("hopeless") },
                  { key: copy("s7.slow"), value: risk("slow") },
                  { key: copy("riskUnknown"), value: number(summary.valueAtRisk.unknownPolicyListingCount) },
                  {
                    key: copy("s8"),
                    value: copy("profit.value", {
                      value: number(summary.profitPerDay.value),
                      currency,
                      cycle: number(summary.profitPerDay.cycleDays),
                    }),
                  },
                  { key: copy("economicsCount"), value: number(summary.profitPerDay.economicsListingCount) },
                  {
                    key: copy("unavailableReason"),
                    value: summary.profitPerDay.unavailableReason
                      ? healthReasonLabel(summary.profitPerDay.unavailableReason)
                      : copy("none"),
                  },
                  {
                    key: copy("economicsReasons"),
                    value: <Reasons values={summary.profitPerDay.economicsUnavailableReasons} />,
                  },
                  { key: copy("costSources"), value: <Reasons values={summary.profitPerDay.costBasisSourceKinds} /> },
                  { key: copy("s9"), value: percent(summary.capitalTurn.value) },
                  { key: copy("capitalCycle"), value: number(summary.capitalTurn.cycleDays) },
                  { key: copy("hurdle"), value: percent(summary.capitalTurn.dailyReturnHurdle) },
                  {
                    key: copy("hurdleSources"),
                    value: <Reasons values={summary.capitalTurn.dailyReturnHurdleSourceKinds} />,
                  },
                  {
                    key: copy("unavailableReason"),
                    value: summary.capitalTurn.unavailableReason
                      ? healthReasonLabel(summary.capitalTurn.unavailableReason)
                      : copy("none"),
                  },
                ]}
              />
            </Card.Body>
          </Card>
        );
      })}
    </Stack>
  );
}
