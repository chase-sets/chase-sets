import { formatMoney } from "@chase-sets/localization";
import { Banner, Card, KeyValueList, NumericSeriesChart, Stack } from "@chase-sets/design-system";
import type { PricingHealthWhatIfResult, PricingHealthWhatIfPortfolio } from "../api/portfolio-what-if";
import { healthCopy as copy, healthNumber as number, healthPercent as percent } from "./copy";

export function PricingHealthWhatIfPanels({ data }: Readonly<{ data: PricingHealthWhatIfResult | null | undefined }>) {
  if (!data) return null;
  if ("status" in data)
    return <NumericSeriesChart label={copy("whatIf.title")} series={[]} error={copy("whatIf.error")} />;
  if (data.portfolios.length === 0) return <Banner tone="info" title={copy("whatIf.empty")} />;
  return (
    <Stack gap={4} data-testid="pricing-health-what-if">
      {data.portfolios.map((portfolio) => (
        <PortfolioWhatIfPanel key={portfolio.key} portfolio={portfolio} />
      ))}
    </Stack>
  );
}

function PortfolioWhatIfPanel({ portfolio }: Readonly<{ portfolio: PricingHealthWhatIfPortfolio }>) {
  const currency = portfolio.currencyCode;
  const horizonPoints = portfolio.horizon.samples.map((sample) => ({
    x: sample.horizonDays,
    y: Number(sample.valueAmount),
    label: copy("whatIf.horizon.point", {
      days: number(sample.horizonDays),
      value: formatMoney(sample.valueAmount, currency),
    }),
  }));
  const hurdlePoints = portfolio.hurdle.scenarios.map((scenario) => ({
    x: scenario.dailyReturnHurdle,
    y: scenario.dailyReturn ?? Number.NaN,
    label: copy("whatIf.hurdle.point", {
      returnValue: percent(scenario.dailyReturn),
      hurdle: percent(scenario.dailyReturnHurdle),
    }),
  }));
  const best = portfolio.hurdle.best;
  return (
    <Card elevation="tinted" data-elevation-role="furniture" data-testid={`pricing-health-what-if-${portfolio.key}`}>
      <Card.Header>
        <Card.Title>{portfolio.label}</Card.Title>
        <Card.Description>
          {copy("whatIf.portfolioDescription", { listings: number(portfolio.listingCount) })}
        </Card.Description>
      </Card.Header>
      <Card.Body>
        <Stack gap={4}>
          {portfolio.excludedCurrencyCount > 0 ? (
            <Banner
              tone="info"
              title={copy("whatIf.excludedCurrency", { count: number(portfolio.excludedCurrencyCount), currency })}
            />
          ) : null}
          <NumericSeriesChart
            label={copy("whatIf.horizon.label", { portfolio: portfolio.label })}
            title={copy("whatIf.horizon.title")}
            series={[
              {
                id: `${portfolio.key}-horizon`,
                name: copy("whatIf.horizon.series"),
                points: horizonPoints,
                tone: "accent",
              },
            ]}
            formatX={(value) => `${number(value)}d`}
            formatY={(value) => formatMoney(value.toFixed(2), currency)}
            emptyTitle={copy("whatIf.empty")}
            insufficientTitle={copy("whatIf.insufficient")}
          />
          <NumericSeriesChart
            label={copy("whatIf.hurdle.label", { portfolio: portfolio.label })}
            title={copy("whatIf.hurdle.title")}
            series={[
              {
                id: `${portfolio.key}-hurdle`,
                name: copy("whatIf.hurdle.series"),
                points: hurdlePoints,
                tone: "success",
                markers: best
                  ? [
                      {
                        x: best.dailyReturnHurdle,
                        y: best.dailyReturn,
                        label: copy("whatIf.hurdle.bestMarker", { hurdle: percent(best.dailyReturnHurdle) }),
                        tone: "success",
                      },
                    ]
                  : [],
              },
            ]}
            formatX={percent}
            formatY={percent}
            emptyTitle={copy("whatIf.noEconomics")}
            insufficientTitle={copy("whatIf.insufficient")}
          />
          <KeyValueList
            items={[
              {
                key: copy("whatIf.configuredHurdle"),
                value: portfolio.hurdle.configuredDailyReturnHurdles.length
                  ? portfolio.hurdle.configuredDailyReturnHurdles.map(percent).join(", ")
                  : copy("unavailable"),
              },
              {
                key: copy("whatIf.bestHurdle"),
                value: best ? `${percent(best.dailyReturnHurdle)} (${percent(best.dailyReturn)})` : copy("whatIf.none"),
              },
              {
                key: copy("whatIf.valueDelta"),
                value:
                  portfolio.hurdle.valueDeltaAmount === null
                    ? copy("unavailable")
                    : formatMoney(portfolio.hurdle.valueDeltaAmount, currency),
              },
              {
                key: copy("whatIf.waitDelta"),
                value:
                  portfolio.hurdle.waitDeltaDays === null
                    ? copy("unavailable")
                    : `${number(portfolio.hurdle.waitDeltaDays)} days`,
              },
              { key: copy("whatIf.snapshot"), value: portfolio.snapshotHash ?? copy("unavailable") },
            ]}
          />
        </Stack>
      </Card.Body>
    </Card>
  );
}
