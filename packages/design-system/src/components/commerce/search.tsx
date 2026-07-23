import type { ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { Box, Grid, IconRow, Inline } from "../../primitives/layout";
import { Button, LinkButton } from "../actions";
import { SearchInput } from "../forms";
import { Card } from "../data-display/card";
import { MarketplaceEmptyState } from "./panels";

export interface SearchFilterPanelProps {
  searchLabel: string;
  filterLabel: string;
  clearLabel?: string;
  popularLabel?: ReactNode;
  placeholder?: string;
  resultCount?: ReactNode;
  appliedFilters?: string[];
  popularSearches?: string[];
  actions?: ReactNode;
}

export function SearchFilterPanel({
  searchLabel,
  filterLabel,
  clearLabel,
  popularLabel,
  placeholder,
  resultCount,
  appliedFilters = [],
  popularSearches = [],
  actions,
}: SearchFilterPanelProps) {
  return (
    <Card>
      <Card.Body>
        <Grid templateColumns="1fr auto" stackUntil="lg" gap={3}>
          <SearchInput label={searchLabel} hideLabel placeholder={placeholder} />
          <Inline gap={2}>
            <Button tone="secondary" leadingIcon="filter">
              {filterLabel}
            </Button>
            {actions}
          </Inline>
        </Grid>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {resultCount ? <span className="font-semibold text-foreground">{resultCount}</span> : null}
          {appliedFilters.map((filter) => (
            <span
              key={filter}
              className="rounded-tokenFull bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            >
              {filter}
            </span>
          ))}
          {appliedFilters.length && clearLabel ? (
            <button className="text-xs font-semibold text-secondary underline-offset-4 hover:underline">
              {clearLabel}
            </button>
          ) : null}
        </div>
        {popularSearches.length ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {popularLabel ? <span className="text-tertiary">{popularLabel}</span> : null}
            {popularSearches.map((search) => (
              <button key={search} className="font-semibold text-accent underline-offset-4 hover:underline">
                {search}
              </button>
            ))}
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

export interface AppliedFilterChipsProps {
  filters: Array<{ id: string; label: ReactNode; onRemove?: () => void }>;
  clearAction?: ReactNode;
  removeLabel?: (label: ReactNode) => string;
}

export function AppliedFilterChips({ filters, clearAction, removeLabel }: AppliedFilterChipsProps) {
  if (!filters.length && !clearAction) {
    return null;
  }

  return (
    <Inline gap={2}>
      {filters.map((filter) => (
        <span
          key={filter.id}
          className="inline-flex min-h-8 items-center gap-2 rounded-tokenFull border border-border bg-surface px-3 text-xs font-semibold text-foreground"
        >
          {filter.label}
          {filter.onRemove ? (
            <button
              type="button"
              className="ds-focus rounded-tokenFull text-tertiary hover:text-foreground"
              aria-label={removeLabel ? removeLabel(filter.label) : undefined}
              onClick={filter.onRemove}
            >
              <Icon name="xCircle" size="sm" tone="inherit" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {clearAction}
    </Inline>
  );
}

export interface SavedSearchPromptProps {
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
}

export function SavedSearchPrompt({ title, description, action }: SavedSearchPromptProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-tokenMd border border-border bg-surface-2 p-4">
      <IconRow gap={3} icon={<Icon name="bell" size="md" tone="accent" aria-hidden="true" />}>
        <div className="font-semibold text-foreground">{title}</div>
        <div className="text-sm leading-5 text-secondary">{description}</div>
      </IconRow>
      {action}
    </div>
  );
}

interface SearchControlBarBaseProps {
  search: ReactNode;
  sort?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  appliedFilters?: ReactNode;
  summary?: ReactNode;
  savedSearch?: ReactNode;
}

/**
 * Filter visibility contract for `SearchControlBar`. `"always"` (the default) renders
 * `filters` at every breakpoint and needs no counterpart. `"desktop"` hides `filters`
 * below `lg` (`hidden lg:block`), so it requires a `mobileFilters` node — rendered
 * `lg:hidden` — to avoid making filtering unreachable on mobile; compiling `"desktop"`
 * without `mobileFilters` is a type error.
 */
export type SearchControlBarProps = SearchControlBarBaseProps &
  ({ filterControlsVisibility?: "always" } | { filterControlsVisibility: "desktop"; mobileFilters: ReactNode });

export function SearchControlBar(props: SearchControlBarProps) {
  const {
    search,
    sort,
    filters,
    actions,
    filterControlsVisibility = "always",
    appliedFilters,
    summary,
    savedSearch,
  } = props;
  const mobileFilters = props.filterControlsVisibility === "desktop" ? props.mobileFilters : undefined;
  const hasControls = Boolean(sort || filters || actions);
  const filterControlsClass = filterControlsVisibility === "desktop" ? "hidden lg:block" : "block";

  return (
    <section className="grid gap-3 rounded-tokenLg border border-border bg-surface p-3 shadow-tokenSm">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <Box minWidth="0">{search}</Box>
        {hasControls ? (
          <div className="flex min-w-0 flex-wrap items-end gap-3 lg:justify-end">
            {sort ? <div className="min-w-44">{sort}</div> : null}
            {filters || actions ? (
              <div className="flex min-w-0 flex-wrap items-end gap-3">
                {filters ? <div className={cx(filterControlsClass, "min-w-44")}>{filters}</div> : null}
                {actions ? <div className="flex items-end">{actions}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {mobileFilters ? <div className="lg:hidden">{mobileFilters}</div> : null}
      {appliedFilters || summary || savedSearch ? (
        <div className="grid gap-3 border-t border-border pt-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="grid gap-2">
            {appliedFilters}
            {summary ? (
              <div className="text-sm text-secondary" role="status" aria-live="polite" aria-atomic="true">
                {summary}
              </div>
            ) : null}
          </div>
          {savedSearch}
        </div>
      ) : null}
    </section>
  );
}

export interface NoResultsRecoveryProps {
  title: ReactNode;
  description: ReactNode;
  recommendations?: ReadonlyArray<{
    href: string;
    id: string;
    label: ReactNode;
  }>;
  savedSearchAction?: ReactNode;
  resetAction?: ReactNode;
  trustCue?: ReactNode;
}

export function NoResultsRecovery({
  title,
  description,
  recommendations = [],
  savedSearchAction,
  resetAction,
  trustCue,
}: NoResultsRecoveryProps) {
  return (
    <MarketplaceEmptyState
      title={title}
      description={description}
      recommendationActions={
        recommendations.length
          ? recommendations.map((recommendation) => (
              <LinkButton key={recommendation.id} href={recommendation.href} tone="ghost" size="sm">
                {recommendation.label}
              </LinkButton>
            ))
          : undefined
      }
      trustCue={trustCue}
      recoveryActions={
        <>
          {resetAction}
          {savedSearchAction}
        </>
      }
    />
  );
}
