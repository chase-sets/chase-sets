import { formatBpsPercent, formatMoney, t } from "@chase-sets/localization";
import { Fragment, useId } from "react";
import { useSearchParams } from "react-router";
import {
  Badge,
  BulkActionBar,
  Button,
  Card,
  DataTable,
  Grid,
  Heading,
  SegmentedControl,
  Select,
  Stack,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";
import fixture from "./deals-framing-fixture.json" with { type: "json" };

// Static, never-merged framing probe: renders frozen staging board rows under
// two page framings so they can be compared side by side. No loader, no
// mutations; the filter rail, sort preset and bulk bar are inert chrome.

export type DealsFramingVariant = "a" | "b";
export type DealsFramingSide = "buy" | "sell";

type FixtureRow = (typeof fixture.boards.sell.rows)[number];

// U+2212 MINUS SIGN for below-benchmark gaps, U+002B PLUS SIGN for above.
const SIDE_SIGN: Record<DealsFramingSide, string> = { buy: "−", sell: "+" };

export function readDealsFramingVariant(value: string | null): DealsFramingVariant {
  return value === "b" ? "b" : "a";
}

export function readDealsFramingSide(value: string | null): DealsFramingSide {
  return value === "sell" ? "sell" : "buy";
}

function sideTitle(side: DealsFramingSide) {
  return side === "buy"
    ? t("discovery.routes.dealsFramingProbe.title.under.market")
    : t("discovery.routes.dealsFramingProbe.title.over.market");
}

function money(amount: string) {
  return formatMoney(amount, fixture.currencyCode);
}

function signedPercent(side: DealsFramingSide, gapPercent: string) {
  return `${SIDE_SIGN[side]}${formatBpsPercent(Number(gapPercent) * 100)}`;
}

export function formatDealsFramingGap(variant: DealsFramingVariant, side: DealsFramingSide, row: FixtureRow) {
  const percent = signedPercent(side, row.gapPercent);
  const benchmark = money(row.benchmark);

  if (variant === "b") {
    return t("discovery.routes.dealsFramingProbe.gap.b", { price: money(row.price), benchmark, percent });
  }

  const gap = `${SIDE_SIGN[side]}${money(row.gapAmount)}`;
  return side === "buy"
    ? t("discovery.routes.dealsFramingProbe.gap.a.buy", { gap, percent, benchmark })
    : t("discovery.routes.dealsFramingProbe.gap.a.sell", { gap, percent, benchmark });
}

// Break opportunities after each "::" and "|" separator let the verbatim product
// identifier wrap at narrow widths without changing its text content.
function ProductIdentifier({ value }: { value: string }) {
  return (
    <Text size="sm" wrap="break">
      {value.split(/(?<=::|\|)/).map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {segment}
        </Fragment>
      ))}
    </Text>
  );
}

function buildColumns(variant: DealsFramingVariant, side: DealsFramingSide): DataColumn<FixtureRow>[] {
  const gapCell = (row: FixtureRow) => (
    <Stack gap={1} align="start">
      <Badge tone={variant === "a" ? "deal" : "neutral"} data-deals-probe-badge="">
        {variant === "a" ? t("discovery.routes.dealsFramingProbe.badge.deal") : sideTitle(side)}
      </Badge>
      <Text size="sm" data-deals-probe-gap="">
        {formatDealsFramingGap(variant, side, row)}
      </Text>
    </Stack>
  );

  const product: DataColumn<FixtureRow> = {
    key: "product",
    header: t("discovery.routes.dealsFramingProbe.column.product"),
    cell: (row) => <ProductIdentifier value={row.product} />,
  };
  const quantity: DataColumn<FixtureRow> = {
    key: "quantity",
    header: t("discovery.routes.dealsFramingProbe.column.quantity"),
    align: "right",
    cell: (row) => String(row.quantity),
  };
  const action: DataColumn<FixtureRow> = {
    key: "action",
    header: t("discovery.routes.dealsFramingProbe.column.action"),
    cell: () => (
      <Button type="button" tone="secondary" size="sm">
        {side === "buy"
          ? t("discovery.routes.dealsFramingProbe.add.to.cart")
          : t("discovery.routes.dealsFramingProbe.add.to.sell.list")}
      </Button>
    ),
  };

  if (variant === "b") {
    return [
      product,
      { key: "price", header: t("discovery.routes.dealsFramingProbe.column.price"), cell: gapCell },
      quantity,
      action,
    ];
  }

  return [
    product,
    {
      key: "price",
      header: t("discovery.routes.dealsFramingProbe.column.price"),
      align: "right",
      cell: (row) => money(row.price),
    },
    { key: "benchmark", header: t("discovery.routes.dealsFramingProbe.column.benchmark"), cell: gapCell },
    quantity,
    action,
  ];
}

export default function DealsFramingProbeRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const titleId = useId();
  const variant = readDealsFramingVariant(searchParams.get("variant"));
  const side = readDealsFramingSide(searchParams.get("side"));
  const rows: FixtureRow[] = fixture.boards[side].rows;
  const title = variant === "a" ? t("discovery.routes.dealsFramingProbe.title.deals") : sideTitle(side);
  const segments =
    variant === "a"
      ? [
          { value: "buy", label: t("discovery.routes.dealsFramingProbe.segment.buy") },
          { value: "sell", label: t("discovery.routes.dealsFramingProbe.segment.sell") },
        ]
      : [
          { value: "buy", label: sideTitle("buy") },
          { value: "sell", label: sideTitle("sell") },
        ];

  function handleSideChange(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set("side", readDealsFramingSide(next));
    setSearchParams(params, { replace: true });
  }

  return (
    <Grid templateColumns="18rem minmax(0, 1fr)" stackUntil="lg" gap={6}>
      <Card elevation="outlined">
        <Heading level={2} visualSize={4}>
          {t("discovery.routes.dealsFramingProbe.filters")}
        </Heading>
      </Card>
      <Stack
        gap={4}
        minWidth="0"
        data-deals-probe-variant={variant}
        data-deals-probe-side={side}
        data-deals-probe-row-count={rows.length}
      >
        <Heading level={1} id={titleId}>
          {title}
        </Heading>
        <SegmentedControl aria-labelledby={titleId} items={segments} value={side} onValueChange={handleSideChange} />
        <Select
          label={t("discovery.routes.dealsFramingProbe.sort")}
          items={[{ value: "newest", label: t("discovery.routes.dealsFramingProbe.sort.newest") }]}
          value="newest"
          disabled
        />
        <DataTable
          rows={rows}
          columns={buildColumns(variant, side)}
          getRowId={(row) => String(row.rank)}
          emptyTitle={t("discovery.routes.dealsFramingProbe.empty.title")}
          emptyDescription={t("discovery.routes.dealsFramingProbe.empty.description")}
        />
        <BulkActionBar count={0} />
      </Stack>
    </Grid>
  );
}
