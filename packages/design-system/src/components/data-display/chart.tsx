import { useId, useMemo, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { VisuallyHidden } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import { EmptyState } from "../feedback/empty-state";
import type { BadgeTone } from "../feedback/shared";

/**
 * Chart primitives are hand-rolled SVG rather than a charting dependency: `Sparkline`
 * and `TimeSeriesChart` only ever need a line/step/band/marker vocabulary, and a
 * bundled library would add supply-chain and CSP surface for a shape this small.
 * Record: no external chart dependency for these two primitives (issue #4306).
 */

export type ChartTone = BadgeTone;

const chartToneRotation: readonly ChartTone[] = [
  "accent",
  "trust",
  "success",
  "warning",
  "danger",
  "info",
  "deal",
  "rating",
];

const chartStrokeToneClasses: Record<ChartTone, string> = {
  neutral: "stroke-secondary",
  accent: "stroke-accent",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  info: "stroke-info",
  trust: "stroke-trust",
  deal: "stroke-deal",
  rating: "stroke-rating",
};

const chartFillToneClasses: Record<ChartTone, string> = {
  neutral: "fill-secondary",
  accent: "fill-accent",
  success: "fill-success",
  warning: "fill-warning",
  danger: "fill-danger",
  info: "fill-info",
  trust: "fill-trust",
  deal: "fill-deal",
  rating: "fill-rating",
};

const chartSoftFillToneClasses: Record<ChartTone, string> = {
  neutral: "fill-muted",
  accent: "fill-accent-soft",
  success: "fill-success-soft",
  warning: "fill-warning-soft",
  danger: "fill-danger-soft",
  info: "fill-info-soft",
  trust: "fill-trust-soft",
  deal: "fill-deal-soft",
  rating: "fill-rating-soft",
};

function reactId(seed: string): string {
  return seed.replaceAll(":", "");
}

function formatNumber(value: number): string {
  return String(value);
}

function scaleLinear(value: number, domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): number {
  if (domainMax === domainMin) {
    return (rangeMin + rangeMax) / 2;
  }

  const ratio = (value - domainMin) / (domainMax - domainMin);
  return rangeMin + ratio * (rangeMax - rangeMin);
}

function padDomain(min: number, max: number, ratio: number): [number, number] {
  const span = max - min;
  const pad = span === 0 ? Math.max(Math.abs(max) * ratio, 1) : span * ratio;
  return [min - pad, max + pad];
}

type Point = readonly [number, number];

function fmt(value: number): string {
  return value.toFixed(2);
}

function toLinePath(points: readonly Point[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${fmt(x)},${fmt(y)}`).join(" ");
}

function toStepPath(points: readonly Point[]): string {
  if (points.length === 0) {
    return "";
  }

  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let index = 1; index < points.length; index += 1) {
    const [, prevY] = points[index - 1];
    const [x, y] = points[index];
    d += ` L${fmt(x)},${fmt(prevY)} L${fmt(x)},${fmt(y)}`;
  }
  return d;
}

function toAreaPath(points: readonly Point[], baselineY: number): string {
  if (points.length === 0) {
    return "";
  }

  const line = toLinePath(points);
  const [firstX] = points[0];
  const [lastX] = points[points.length - 1];
  return `${line} L${fmt(lastX)},${fmt(baselineY)} L${fmt(firstX)},${fmt(baselineY)} Z`;
}

function toBandPath(topPoints: readonly Point[], bottomPoints: readonly Point[]): string {
  if (topPoints.length === 0 || bottomPoints.length === 0) {
    return "";
  }

  const forward = toLinePath(topPoints);
  const backward = [...bottomPoints]
    .reverse()
    .map(([x, y]) => `L${fmt(x)},${fmt(y)}`)
    .join(" ");
  return `${forward} ${backward} Z`;
}

/* -------------------------------------------------------------------------------------------- */
/* Sparkline                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export interface SparklinePoint {
  value: number;
  label?: string;
}

export interface SparklineProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  /** Raw values, or points carrying an optional accessible/tooltip label per sample. */
  data: readonly (number | SparklinePoint)[];
  /** Accessible name for the chart region, e.g. "30-day price trend for Charizard VMAX". */
  label: string;
  tone?: ChartTone;
  width?: number;
  height?: number;
  strokeWidth?: number;
  /** Renders a soft tone-tinted fill under the line. Defaults to on. */
  area?: boolean;
  /** Fewest samples required before the trend line renders instead of the insufficient-data state. */
  minimumSamples?: number;
  formatValue?: (value: number) => string;
  /** Overrides the generated screen-reader summary sentence. */
  summary?: ReactNode;
  emptyLabel?: ReactNode;
  insufficientLabel?: ReactNode;
}

export function Sparkline({
  data,
  label,
  tone = "accent",
  width = 120,
  height = 32,
  strokeWidth = 2,
  area = true,
  minimumSamples = 2,
  formatValue = formatNumber,
  summary,
  emptyLabel = "No data yet.",
  insufficientLabel = "Not enough data yet.",
  ...rest
}: SparklineProps) {
  const motionSettings = useChaseMotion();
  const summaryId = `chase-sparkline-summary-${reactId(useId())}`;
  const nativeProps = toMotionDomProps(rest);
  const points = useMemo<SparklinePoint[]>(
    () => data.map((entry) => (typeof entry === "number" ? { value: entry } : entry)),
    [data],
  );

  if (points.length < minimumSamples) {
    const description = points.length === 0 ? emptyLabel : insufficientLabel;

    return (
      <div {...nativeProps} className="inline-block" style={{ width, height }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height="100%"
          role="img"
          aria-label={label}
          aria-describedby={summaryId}
          focusable="false"
        >
          <line
            x1={strokeWidth}
            y1={height / 2}
            x2={width - strokeWidth}
            y2={height / 2}
            className="stroke-muted"
            strokeWidth={strokeWidth}
            strokeDasharray="4 4"
            strokeLinecap="round"
          />
        </svg>
        <VisuallyHidden id={summaryId}>{description}</VisuallyHidden>
      </div>
    );
  }

  const values = points.map((point) => point.value);
  const paddingY = Math.max(strokeWidth, 2);
  const [domainMin, domainMax] = padDomain(Math.min(...values), Math.max(...values), 0.08);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const geometryPoints: Point[] = values.map((value, index) => [
    values.length > 1 ? index * stepX : width / 2,
    scaleLinear(value, domainMin, domainMax, height - paddingY, paddingY),
  ]);
  const linePath = toLinePath(geometryPoints);
  const areaPath = area ? toAreaPath(geometryPoints, height) : null;
  const first = values[0];
  const last = values[values.length - 1];
  const trend = last > first ? "trending up" : last < first ? "trending down" : "flat";
  const defaultSummary = `${points.length} data points. First ${formatValue(first)}, last ${formatValue(last)}, ${trend}.`;
  const drawMotion = motionSettings.reducedMotion
    ? undefined
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: motionSettings.durations.slow, ease: motionSettings.easing },
      };

  return (
    <div {...nativeProps} className="inline-block" style={{ width, height }}>
      <motion.svg
        {...(drawMotion ?? {})}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={label}
        aria-describedby={summaryId}
        focusable="false"
        preserveAspectRatio="none"
      >
        {areaPath ? <path d={areaPath} className={chartSoftFillToneClasses[tone]} stroke="none" /> : null}
        <path
          d={linePath}
          className={chartStrokeToneClasses[tone]}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.svg>
      <VisuallyHidden id={summaryId}>{summary ?? defaultSummary}</VisuallyHidden>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* TimeSeriesChart                                                                               */
/* -------------------------------------------------------------------------------------------- */

export interface TimeSeriesPoint {
  /** Sortable position on the time axis, typically an epoch-millisecond timestamp. */
  timestamp: number;
  value: number;
  /** Caller-formatted, already-localized accessible/tooltip text for this sample. */
  label?: string;
}

export interface TimeSeriesBandPoint {
  timestamp: number;
  min: number;
  max: number;
}

export interface TimeSeriesMarker {
  timestamp: number;
  value: number;
  /** Required accessible description, e.g. "Verified sale, $42.00, Jul 3". */
  label: string;
  tone?: ChartTone;
}

export type TimeSeriesCurve = "line" | "step";

export interface TimeSeriesSeries {
  id: string;
  /** Localized series name shown in the legend and screen-reader summary. */
  name: string;
  points: readonly TimeSeriesPoint[];
  tone?: ChartTone;
  curve?: TimeSeriesCurve;
  /** Optional min/max range (e.g. comp spread) rendered as a soft band behind the line. */
  band?: readonly TimeSeriesBandPoint[];
  /** Discrete highlighted samples, e.g. verified-sale markers. */
  markers?: readonly TimeSeriesMarker[];
}

export interface TimeSeriesChartProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  series: readonly TimeSeriesSeries[];
  /** Accessible name for the chart region. */
  label: string;
  /** Optional visible heading rendered above the plot. */
  title?: ReactNode;
  /** Integration point for a caller-supplied time-range control (e.g. a SegmentedControl). */
  rangeSelector?: ReactNode;
  height?: number;
  /** Fewest samples (across the widest series) required before the plot renders. */
  minimumSamples?: number;
  showLegend?: boolean;
  formatValue?: (value: number) => string;
  /** Minimum pixel width before the plot scrolls horizontally instead of compressing further. */
  minChartWidth?: number;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  insufficientTitle?: ReactNode;
  insufficientDescription?: ReactNode;
  /** Overrides the generated screen-reader summary. */
  summary?: ReactNode;
}

const viewWidth = 640;
const paddingX = 12;

function resolveSeriesTone(series: Readonly<{ tone?: ChartTone }>, index: number): ChartTone {
  return series.tone ?? chartToneRotation[index % chartToneRotation.length];
}

export function TimeSeriesChart({
  series,
  label,
  title,
  rangeSelector,
  height = 220,
  minimumSamples = 2,
  showLegend,
  formatValue = formatNumber,
  minChartWidth,
  emptyTitle = "No data yet",
  emptyDescription = "Data will appear here once activity accumulates.",
  insufficientTitle = "Not enough data yet",
  insufficientDescription,
  summary,
  ...rest
}: TimeSeriesChartProps) {
  const motionSettings = useChaseMotion();
  const summaryId = `chase-timeseries-summary-${reactId(useId())}`;
  const nativeProps = toMotionDomProps(rest);
  const resolvedShowLegend = showLegend ?? series.length > 1;
  const maxSamples = series.reduce((max, entry) => Math.max(max, entry.points.length), 0);
  const hasAnyData = series.some((entry) => entry.points.length > 0);
  const resolvedInsufficientDescription =
    insufficientDescription ?? `At least ${minimumSamples} data points are required to show a reliable trend.`;

  if (!hasAnyData || maxSamples < minimumSamples) {
    return (
      <div {...nativeProps}>
        <EmptyState
          icon="chart"
          title={hasAnyData ? insufficientTitle : emptyTitle}
          description={hasAnyData ? resolvedInsufficientDescription : emptyDescription}
        />
      </div>
    );
  }

  const allTimestamps = series.flatMap((entry) => [
    ...entry.points.map((point) => point.timestamp),
    ...(entry.band ?? []).map((point) => point.timestamp),
  ]);
  const allValues = series.flatMap((entry) => [
    ...entry.points.map((point) => point.value),
    ...(entry.band ?? []).flatMap((point) => [point.min, point.max]),
  ]);
  const [domainMinTs, domainMaxTs] = [Math.min(...allTimestamps), Math.max(...allTimestamps)];
  const [domainMinValue, domainMaxValue] = padDomain(Math.min(...allValues), Math.max(...allValues), 0.08);
  const plotWidth = viewWidth - paddingX * 2;
  const plotHeight = height - paddingX * 2;

  const xScale = (timestamp: number) => paddingX + scaleLinear(timestamp, domainMinTs, domainMaxTs, 0, plotWidth);
  const yScale = (value: number) => paddingX + scaleLinear(value, domainMinValue, domainMaxValue, plotHeight, 0);

  const drawMotion = motionSettings.reducedMotion
    ? undefined
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: motionSettings.durations.slow, ease: motionSettings.easing },
      };

  const seriesGeometry = series.map((entry, index) => {
    const tone = resolveSeriesTone(entry, index);
    const sortedPoints = [...entry.points].sort((left, right) => left.timestamp - right.timestamp);
    const geometryPoints: Point[] = sortedPoints.map((point) => [xScale(point.timestamp), yScale(point.value)]);
    const linePath = entry.curve === "step" ? toStepPath(geometryPoints) : toLinePath(geometryPoints);
    const sortedBand = [...(entry.band ?? [])].sort((left, right) => left.timestamp - right.timestamp);
    const bandPath =
      sortedBand.length > 0
        ? toBandPath(
            sortedBand.map((point): Point => [xScale(point.timestamp), yScale(point.max)]),
            sortedBand.map((point): Point => [xScale(point.timestamp), yScale(point.min)]),
          )
        : null;
    const values = sortedPoints.map((point) => point.value);

    return {
      entry,
      tone,
      linePath,
      bandPath,
      min: Math.min(...values),
      max: Math.max(...values),
      count: sortedPoints.length,
    };
  });

  const defaultSummary = seriesGeometry
    .map(
      ({ entry, min, max, count }) =>
        `${entry.name}: ${count} points, from ${formatValue(min)} to ${formatValue(max)}.`,
    )
    .concat(series.flatMap((entry) => (entry.markers ?? []).map((marker) => `${entry.name} marker: ${marker.label}.`)))
    .join(" ");

  return (
    <div {...nativeProps}>
      {title || rangeSelector ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          {title ? <div className="text-sm font-semibold text-foreground">{title}</div> : <span />}
          {rangeSelector}
        </div>
      ) : null}
      <div className="w-full overflow-x-auto">
        <div style={minChartWidth ? { minWidth: minChartWidth } : undefined}>
          <motion.svg
            {...(drawMotion ?? {})}
            viewBox={`0 0 ${viewWidth} ${height}`}
            width="100%"
            height={height}
            role="img"
            aria-label={label}
            aria-describedby={summaryId}
            focusable="false"
            className="h-auto w-full max-w-full"
          >
            {seriesGeometry.map(({ entry, tone, bandPath }) =>
              bandPath ? (
                <path key={`${entry.id}-band`} d={bandPath} className={chartSoftFillToneClasses[tone]} stroke="none" />
              ) : null,
            )}
            {seriesGeometry.map(({ entry, tone, linePath }) => (
              <path
                key={`${entry.id}-line`}
                d={linePath}
                className={chartStrokeToneClasses[tone]}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {series.map((entry, index) => {
              const tone = resolveSeriesTone(entry, index);
              return (entry.markers ?? []).map((marker) => (
                <circle
                  key={`${entry.id}-marker-${marker.timestamp}-${marker.value}`}
                  cx={xScale(marker.timestamp)}
                  cy={yScale(marker.value)}
                  r={4}
                  className={cx(chartFillToneClasses[marker.tone ?? tone], "stroke-background")}
                  strokeWidth={1.5}
                >
                  <title>{marker.label}</title>
                </circle>
              ));
            })}
          </motion.svg>
        </div>
      </div>
      {resolvedShowLegend ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((entry, index) => {
            const tone = resolveSeriesTone(entry, index);
            return (
              <li key={entry.id} className="flex items-center gap-2 text-xs text-secondary">
                <span aria-hidden="true" className={cx("h-2 w-2 rounded-tokenFull", chartFillToneClasses[tone])} />
                {entry.name}
              </li>
            );
          })}
        </ul>
      ) : null}
      <VisuallyHidden id={summaryId}>{summary ?? defaultSummary}</VisuallyHidden>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* NumericSeriesChart                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** A finite point on a numeric x/y axis. Non-finite points are ignored by the primitive. */
export interface NumericSeriesPoint {
  x: number;
  y: number;
  /** Caller-formatted sample text for the accessible table. */
  label?: string;
}

export interface NumericSeriesMarker {
  x: number;
  y: number;
  label: string;
  tone?: ChartTone;
}

export interface NumericSeries {
  id: string;
  name: string;
  points: readonly NumericSeriesPoint[];
  tone?: ChartTone;
  markers?: readonly NumericSeriesMarker[];
}

export interface NumericSeriesChartProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  series: readonly NumericSeries[];
  label: string;
  title?: ReactNode;
  height?: number;
  minimumSamples?: number;
  showLegend?: boolean;
  formatX?: (value: number) => string;
  formatY?: (value: number) => string;
  /** A visible accessible table is rendered by default so samples are never chart-only data. */
  showTable?: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  insufficientTitle?: ReactNode;
  insufficientDescription?: ReactNode;
  error?: ReactNode;
  errorTitle?: ReactNode;
  summary?: ReactNode;
}

export function NumericSeriesChart({
  series,
  label,
  title,
  height = 220,
  minimumSamples = 2,
  showLegend,
  formatX = formatNumber,
  formatY = formatNumber,
  showTable = true,
  emptyTitle = "No data yet",
  emptyDescription = "Data will appear here once activity accumulates.",
  insufficientTitle = "Not enough data yet",
  insufficientDescription,
  error,
  errorTitle = "Chart unavailable",
  summary,
  ...rest
}: NumericSeriesChartProps) {
  const motionSettings = useChaseMotion();
  const summaryId = `chase-numeric-series-summary-${reactId(useId())}`;
  const nativeProps = toMotionDomProps(rest);
  const finiteSeries = series.map((entry) => ({
    ...entry,
    points: entry.points
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .sort((left, right) => left.x - right.x),
    markers: (entry.markers ?? []).filter((marker) => Number.isFinite(marker.x) && Number.isFinite(marker.y)),
  }));
  const maxSamples = finiteSeries.reduce((max, entry) => Math.max(max, entry.points.length), 0);
  const hasAnyData = finiteSeries.some((entry) => entry.points.length > 0);
  const resolvedInsufficientDescription =
    insufficientDescription ?? `At least ${minimumSamples} data points are required to show a reliable trend.`;

  if (error) {
    return (
      <div {...nativeProps} role="alert">
        <EmptyState icon="chart" title={errorTitle} description={error} />
      </div>
    );
  }
  if (!hasAnyData || maxSamples < minimumSamples) {
    return (
      <div {...nativeProps}>
        <EmptyState
          icon="chart"
          title={hasAnyData ? insufficientTitle : emptyTitle}
          description={hasAnyData ? resolvedInsufficientDescription : emptyDescription}
        />
        {showTable && hasAnyData ? (
          <NumericSampleTable series={finiteSeries} formatX={formatX} formatY={formatY} />
        ) : null}
      </div>
    );
  }

  const allPoints = finiteSeries.flatMap((entry) => entry.points);
  const [domainMinX, domainMaxX] = padDomain(
    Math.min(...allPoints.map((point) => point.x)),
    Math.max(...allPoints.map((point) => point.x)),
    0.04,
  );
  const [domainMinY, domainMaxY] = padDomain(
    Math.min(...allPoints.map((point) => point.y)),
    Math.max(...allPoints.map((point) => point.y)),
    0.08,
  );
  const plotWidth = viewWidth - paddingX * 2;
  const plotHeight = height - paddingX * 2;
  const xScale = (value: number) => paddingX + scaleLinear(value, domainMinX, domainMaxX, 0, plotWidth);
  const yScale = (value: number) => paddingX + scaleLinear(value, domainMinY, domainMaxY, plotHeight, 0);
  const drawMotion = motionSettings.reducedMotion
    ? undefined
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: motionSettings.durations.slow, ease: motionSettings.easing },
      };
  const geometry = finiteSeries.map((entry, index) => {
    const tone = resolveSeriesTone(entry, index);
    const points = [...entry.points].sort((left, right) => left.x - right.x);
    return {
      entry,
      tone,
      points,
      path: toLinePath(points.map((point) => [xScale(point.x), yScale(point.y)] as Point)),
    };
  });
  const defaultSummary = geometry
    .map(
      ({ entry, points }) =>
        `${entry.name}: ${points.length} samples, from ${formatY(points[0]!.y)} to ${formatY(points.at(-1)!.y)}.`,
    )
    .concat(
      finiteSeries.flatMap((entry) => (entry.markers ?? []).map((marker) => `${entry.name} marker: ${marker.label}.`)),
    )
    .join(" ");
  const resolvedShowLegend = showLegend ?? finiteSeries.length > 1;

  return (
    <div {...nativeProps}>
      {title ? <div className="mb-3 text-sm font-semibold text-foreground">{title}</div> : null}
      <motion.svg
        {...(drawMotion ?? {})}
        viewBox={`0 0 ${viewWidth} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={label}
        aria-describedby={summaryId}
        focusable="false"
        className="h-auto w-full max-w-full"
      >
        {geometry.map(({ entry, tone, path }) => (
          <path
            key={`${entry.id}-line`}
            d={path}
            className={chartStrokeToneClasses[tone]}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {geometry.flatMap(({ entry, tone }) =>
          (entry.markers ?? []).map((marker) => (
            <circle
              key={`${entry.id}-marker-${marker.x}-${marker.y}`}
              cx={xScale(marker.x)}
              cy={yScale(marker.y)}
              r={4}
              className={cx(chartFillToneClasses[marker.tone ?? tone], "stroke-background")}
              strokeWidth={1.5}
            >
              <title>{marker.label}</title>
            </circle>
          )),
        )}
      </motion.svg>
      {resolvedShowLegend ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {finiteSeries.map((entry, index) => {
            const tone = resolveSeriesTone(entry, index);
            return (
              <li key={entry.id} className="flex items-center gap-2 text-xs text-secondary">
                <span aria-hidden="true" className={cx("h-2 w-2 rounded-tokenFull", chartFillToneClasses[tone])} />
                {entry.name}
              </li>
            );
          })}
        </ul>
      ) : null}
      {showTable ? <NumericSampleTable series={finiteSeries} formatX={formatX} formatY={formatY} /> : null}
      <VisuallyHidden id={summaryId}>{summary ?? defaultSummary}</VisuallyHidden>
    </div>
  );
}

function NumericSampleTable({
  series,
  formatX,
  formatY,
}: Readonly<{
  series: readonly NumericSeries[];
  formatX: (value: number) => string;
  formatY: (value: number) => string;
}>) {
  return (
    <table className="mt-3 w-full text-left text-xs" aria-label="Chart samples" tabIndex={0}>
      <caption className="sr-only">Chart samples</caption>
      <thead>
        <tr>
          <th scope="col">X</th>
          <th scope="col">Y</th>
          <th scope="col">Series</th>
        </tr>
      </thead>
      <tbody>
        {series.flatMap((entry) =>
          entry.points.map((point, index) => (
            <tr key={`${entry.id}-${point.x}-${index}`}>
              <td>{formatX(point.x)}</td>
              <td>{point.label ?? formatY(point.y)}</td>
              <td>{entry.name}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}
