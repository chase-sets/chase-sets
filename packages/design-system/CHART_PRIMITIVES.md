# Chart Primitives

`Sparkline` and `TimeSeriesChart` are the design system's only charting components (`packages/design-system/src/components/data-display/chart.tsx`). They are hand-rolled SVG rather than a charting dependency: a bundled library would add supply-chain and CSP surface for a shape this small. No context should own local chart code — build once here, consume everywhere.

## Decision: no charting dependency

`Sparkline` and `TimeSeriesChart` cover the whole current need: inline trend lines and a multi-series line/step/band/marker workhorse. Both are small enough to hand-roll in plain SVG with no measurement dependencies (no `getBBox`/`getTotalLength`), which keeps them safe to render in tests and server environments alike. Reconsider only if a future surface needs interaction models a hand-rolled primitive cannot reasonably provide (pan/zoom, canvas-scale point counts).

## Sparkline

Use for an inline mini price-trend inside cards, rows, or list cells. No axes, no legend — just a line and an optional soft area fill.

- `data`: raw numbers or `{ value, label? }` points.
- `label`: required accessible name for the region (e.g. `"30-day price trend for Charizard VMAX"`).
- `tone`: any design-system badge tone (`neutral | accent | success | warning | danger | info | trust | deal | rating`); resolves to `stroke-{tone}` / `fill-{tone}-soft` token classes, never a raw color.
- `minimumSamples` (default `2`): fewer samples renders the insufficient-data placeholder instead of a misleading line.
- `emptyLabel` / `insufficientLabel`: copy-injectable, English defaults, always overridable by the caller for localization.
- `summary`: overrides the generated screen-reader sentence entirely.

## TimeSeriesChart

The workhorse for market-analytics surfaces: multiple series, each with its own tone, `line` or `step` curve, an optional min/max `band` (comp-price spread), and `markers` (e.g. verified-sale dots).

- `series`: array of `{ id, name, points, tone?, curve?, band?, markers? }`.
- `label`: required accessible chart name.
- `title` / `rangeSelector`: optional header slots — `rangeSelector` is the integration point for a caller-supplied time-range control (e.g. a `SegmentedControl`); the chart does not implement range selection itself.
- `minimumSamples` (default `2`): gates a first-class insufficient-data `EmptyState`, distinct from the zero-data `EmptyState`. Minimum-sample messaging is not an afterthought — both states render through the shared `EmptyState` primitive with copy-injectable title/description.
- `minChartWidth`: opt-in minimum pixel width for dense series; the plot then scrolls horizontally inside its own container instead of compressing illegibly or overflowing the page (m76 responsive contract).
- Legend renders automatically from series tone + name whenever more than one series is present (`showLegend` overrides).
- Every series contributes a sentence to the generated screen-reader summary (`{name}: {count} points, from {min} to {max}`), plus one sentence per marker; `summary` overrides the whole thing.

## Accessibility

Both components render the plot as `role="img"` with a required `label` accessible name, and pair it with `aria-describedby` pointing at a `VisuallyHidden` series summary — a chart is not exempt from a11y. Verified-sale markers additionally carry a native SVG `<title>` per marker.

## Motion

Both components fade in on mount using the shared `useChaseMotion()` settings and render with no entrance animation at all when reduced motion is active — never an animated line draw.

## Fresh-State Rules

- No raw hex/rgb colors: every stroke and fill resolves through the tone-to-token class maps in `chart.tsx`.
- Data comes in entirely through props (`series`, `data`); these are presentational primitives with no fetching, polling, or context coupling.
- Do not build a context-local chart, sparkline, or trend line anywhere else in the repository — extend these two primitives instead.
