import type { ReactNode } from "react";
import { Bell, XCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../actions";
import { SearchInput } from "../forms";
import { Card, CardContent } from "../compat/card";
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
      <CardContent className="gap-4 p-0">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <SearchInput label={searchLabel} hideLabel placeholder={placeholder} />
          <div className="flex flex-wrap gap-2">
            <Button tone="secondary" leadingIcon="filter">
              {filterLabel}
            </Button>
            {actions}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {resultCount ? <span className="font-semibold text-[var(--foreground)]">{resultCount}</span> : null}
          {appliedFilters.map((filter) => (
            <span
              key={filter}
              className="rounded-tokenFull bg-[var(--primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--primary)]"
            >
              {filter}
            </span>
          ))}
          {appliedFilters.length && clearLabel ? (
            <button className="text-xs font-semibold text-[var(--text-secondary)] underline-offset-4 hover:underline">
              {clearLabel}
            </button>
          ) : null}
        </div>
        {popularSearches.length ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {popularLabel ? <span className="text-[var(--muted-foreground)]">{popularLabel}</span> : null}
            {popularSearches.map((search) => (
              <button key={search} className="font-semibold text-[var(--primary)] underline-offset-4 hover:underline">
                {search}
              </button>
            ))}
          </div>
        ) : null}
      </CardContent>
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
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <span
          key={filter.id}
          className="inline-flex min-h-8 items-center gap-2 rounded-tokenFull border border-[var(--border)] bg-[var(--card)] px-3 text-xs font-semibold text-[var(--foreground)]"
        >
          {filter.label}
          {filter.onRemove ? (
            <button
              type="button"
              className="ds-focus rounded-tokenFull text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={removeLabel ? removeLabel(filter.label) : undefined}
              onClick={filter.onRemove}
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {clearAction}
    </div>
  );
}

export interface SavedSearchPromptProps {
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
}

export function SavedSearchPrompt({ title, description, action }: SavedSearchPromptProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex gap-3">
        <Bell className="mt-0.5 h-5 w-5 text-[var(--primary)]" aria-hidden="true" />
        <div>
          <div className="font-semibold text-[var(--foreground)]">{title}</div>
          <div className="text-sm leading-5 text-[var(--text-secondary)]">{description}</div>
        </div>
      </div>
      {action}
    </div>
  );
}

export interface SearchControlBarProps {
  search: ReactNode;
  sort?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  filterControlsVisibility?: "always" | "desktop";
  appliedFilters?: ReactNode;
  summary?: ReactNode;
  savedSearch?: ReactNode;
}

export function SearchControlBar({
  search,
  sort,
  filters,
  actions,
  filterControlsVisibility = "always",
  appliedFilters,
  summary,
  savedSearch,
}: SearchControlBarProps) {
  const hasControls = Boolean(sort || filters || actions);
  const filterControlsClass = filterControlsVisibility === "desktop" ? "hidden lg:block" : "block";

  return (
    <section className="grid gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-3 shadow-[var(--shadow-sm)]">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">{search}</div>
        {hasControls ? (
          <div className="flex min-w-0 flex-wrap items-end gap-3 lg:justify-end">
            {sort ? <div className="min-w-44">{sort}</div> : null}
            {filters || actions ? (
              <div className="flex min-w-0 flex-wrap items-end gap-3">
                {filters ? <div className={cn(filterControlsClass, "min-w-44")}>{filters}</div> : null}
                {actions ? <div className="flex items-end">{actions}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {appliedFilters || summary || savedSearch ? (
        <div className="grid gap-3 border-t border-[var(--border)] pt-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="grid gap-2">
            {appliedFilters}
            {summary ? <div className="text-sm text-[var(--text-secondary)]">{summary}</div> : null}
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
  recommendations?: string[];
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
      recommendations={recommendations}
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
