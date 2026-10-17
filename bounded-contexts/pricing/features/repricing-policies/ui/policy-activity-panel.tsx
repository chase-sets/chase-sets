import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  Inline,
  KeyValueList,
  PageSection,
  Stack,
  Text,
  Toggle,
} from "@chase-sets/design-system";
import type { RepricingActivityFilter, RepricingActivityRow } from "../../repricing-engine/api/activity";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import {
  repricingActivityFilterCopyKeys,
  repricingActivityFilterOrder,
  repricingAlwaysVisibleFilters,
  repricingAnchorWordingCopyKeys,
  repricingClampCopyKeys,
  repricingResultCopyKey,
  resolveRepricingAnchorWording,
} from "./activity-copy";
import { formatRepricingCount, formatRepricingMoney } from "./policy-copy";

export type RepricingActivityPanelPage = Readonly<{
  rows: readonly RepricingActivityRow[];
  next: string | null;
  filterCounts: Readonly<Record<RepricingActivityFilter, number>>;
}>;

const clampOrder = Object.keys(repricingClampCopyKeys) as (keyof typeof repricingClampCopyKeys)[];

function filterLabel(filter: RepricingActivityFilter, counts: RepricingActivityPanelPage["filterCounts"]): string {
  return t("pricing.features.repricingPolicies.ui.activity.filterLabel", {
    label: t(repricingActivityFilterCopyKeys[filter]),
    count: formatRepricingCount(counts[filter]),
  });
}

function outcomeTone(outcome: RepricingPolicyListingTrace["outcome"]) {
  switch (outcome) {
    case "changed":
      return "success" as const;
    case "skipped":
      return "neutral" as const;
    case "pause-requested":
      return "warning" as const;
    case "notify-only":
      return "info" as const;
  }
}

// Only the rendered fields below leave the row: listing, outcome, stratum
// wording, prices, clamps and the frozen count. Nothing about the competing
// listings behind an anchor is ever rendered.
function ResultCell({ row }: { row: RepricingActivityRow }) {
  return (
    <Stack gap={1}>
      <Badge tone={outcomeTone(row.trace.outcome)}>{t(repricingResultCopyKey(row.trace))}</Badge>
      {row.affectedListingCount > 0 ? (
        <Badge tone="warning" data-testid="repricing-activity-frozen">
          {t("pricing.features.repricingPolicies.ui.activity.frozen", {
            count: formatRepricingCount(row.affectedListingCount),
          })}
        </Badge>
      ) : null}
      {row.affectedListingCount > 0 && row.frozenUntil ? (
        <Text size="sm" tone="secondary">
          {t("pricing.features.repricingPolicies.ui.activity.frozen.until", {
            frozenUntil: formatDateTime(row.frozenUntil),
          })}
        </Text>
      ) : null}
    </Stack>
  );
}

function priceLabel(trace: RepricingPolicyListingTrace, currency: string | null | undefined): string {
  const current = formatRepricingMoney(trace.currentPriceAmount, currency);
  if (trace.targetPriceAmount === null || trace.targetPriceAmount === trace.currentPriceAmount) return current;
  return t("pricing.features.repricingPolicies.ui.activity.price.change", {
    current,
    target: formatRepricingMoney(trace.targetPriceAmount, currency),
  });
}

export function PricingRepricingActivityPanel({
  page,
  selectedFilter,
  ruleCurrencies,
  loading = false,
  loadFailed = false,
  onFilterChange,
  onNext,
}: {
  page: RepricingActivityPanelPage | null;
  selectedFilter: RepricingActivityFilter | null;
  // Currency per rule index, so each row's prices format in its rule's currency.
  ruleCurrencies: readonly (string | null | undefined)[];
  loading?: boolean;
  loadFailed?: boolean;
  onFilterChange: (filter: RepricingActivityFilter | null) => void;
  onNext: (cursor: string) => void;
}) {
  const counts = page?.filterCounts ?? null;
  const rows = page?.rows ?? [];

  return (
    <PageSection
      title={t("pricing.features.repricingPolicies.ui.activity.title")}
      description={t("pricing.features.repricingPolicies.ui.activity.description")}
    >
      <Stack gap={4}>
        {counts ? (
          <KeyValueList
            data-testid="repricing-activity-counts"
            layout="grid"
            variant="surface"
            items={repricingAlwaysVisibleFilters.map((filter) => ({
              key: t(repricingActivityFilterCopyKeys[filter]),
              value: formatRepricingCount(counts[filter]),
            }))}
          />
        ) : null}
        {counts ? (
          <FilterBar
            sticky={false}
            role="group"
            aria-label={t("pricing.features.repricingPolicies.ui.activity.filters.label")}
            data-testid="repricing-activity-filters"
          >
            <Inline gap={2}>
              <Toggle
                pressed={selectedFilter === null}
                disabled={loading}
                onPressedChange={(pressed) => {
                  if (pressed) onFilterChange(null);
                }}
              >
                {t("pricing.features.repricingPolicies.ui.activity.filter.all")}
              </Toggle>
              {repricingActivityFilterOrder.map((filter) => (
                <Toggle
                  key={filter}
                  value={filter}
                  pressed={selectedFilter === filter}
                  disabled={loading}
                  onPressedChange={(pressed) => onFilterChange(pressed ? filter : null)}
                >
                  {filterLabel(filter, counts)}
                </Toggle>
              ))}
            </Inline>
          </FilterBar>
        ) : null}
        {loadFailed ? (
          <Banner
            tone="danger"
            title={t("pricing.features.repricingPolicies.ui.activity.error.title")}
            description={t("pricing.features.repricingPolicies.ui.activity.error.description")}
          />
        ) : !loading && rows.length === 0 ? (
          <EmptyState
            data-testid="repricing-activity-empty"
            title={t("pricing.features.repricingPolicies.ui.activity.empty.title")}
            description={t("pricing.features.repricingPolicies.ui.activity.empty.description")}
          />
        ) : (
          <DataTable
            data-testid="repricing-activity"
            caption={t("pricing.features.repricingPolicies.ui.activity.caption")}
            rows={[...rows]}
            loading={loading}
            getRowId={(row) => `${row.listingId}:${row.evaluationId}`}
            columns={[
              {
                key: "listing",
                header: t("pricing.features.repricingPolicies.ui.activity.column.listing"),
                cell: (row) => row.listingId,
              },
              {
                key: "result",
                header: t("pricing.features.repricingPolicies.ui.activity.column.result"),
                cell: (row) => <ResultCell row={row} />,
              },
              {
                key: "anchor",
                header: t("pricing.features.repricingPolicies.ui.activity.column.anchor"),
                cell: (row) => {
                  const wording = resolveRepricingAnchorWording(row.trace);
                  return wording
                    ? t(repricingAnchorWordingCopyKeys[wording])
                    : t("pricing.features.repricingPolicies.ui.activity.anchor.none");
                },
              },
              {
                key: "price",
                header: t("pricing.features.repricingPolicies.ui.activity.column.price"),
                align: "right",
                cell: (row) => priceLabel(row.trace, ruleCurrencies[row.trace.ruleIndex]),
              },
              {
                key: "clamps",
                header: t("pricing.features.repricingPolicies.ui.activity.column.clamps"),
                cell: (row) => (
                  <Inline gap={1}>
                    {clampOrder
                      .filter((clamp) => row.trace.clamps[clamp])
                      .map((clamp) => (
                        <Badge key={clamp} tone="info" variant="outline">
                          {t(repricingClampCopyKeys[clamp])}
                        </Badge>
                      ))}
                  </Inline>
                ),
              },
              {
                key: "evaluated",
                header: t("pricing.features.repricingPolicies.ui.activity.column.evaluated"),
                cell: (row) => formatDateTime(row.evaluatedAt),
              },
            ]}
          />
        )}
        {page?.next && !loadFailed ? (
          <Inline>
            <Button tone="secondary" disabled={loading} onClick={() => onNext(page.next!)}>
              {t("pricing.features.repricingPolicies.ui.activity.more")}
            </Button>
          </Inline>
        ) : null}
      </Stack>
    </PageSection>
  );
}
