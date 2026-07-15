import { useState, type ReactNode } from "react";
import { Button } from "../../components/actions";
import { SearchInput } from "../../components/forms";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../../components/control-sizing";
import { cx } from "../../utils/cx";
import { Badge, BottomSheet, type BottomSheetProps } from "../../components/feedback";
import { Icon, type IconName } from "../../icons";

export interface MarketplaceFacetItem {
  id: string;
  label: string;
  count?: number;
}

export type MarketplaceFacetSelectionMode = "single" | "multiple";

const DEFAULT_MARKETPLACE_FACET_VISIBLE_OPTIONS = 6;

function isMarketplaceFacetItemSelected(
  item: MarketplaceFacetItem,
  selectedValues: ReadonlySet<string> | null,
  selectedId: string,
) {
  return selectedValues?.has(item.id) ?? selectedId === item.id;
}

function getProgressiveMarketplaceFacetItems({
  items,
  normalizedSearch,
  selectedValues,
  selectedId,
  expanded,
  visibleOptionCount,
}: {
  items: MarketplaceFacetItem[];
  normalizedSearch: string;
  selectedValues: ReadonlySet<string> | null;
  selectedId: string;
  expanded: boolean;
  visibleOptionCount: number;
}) {
  const matchesSearch = (item: MarketplaceFacetItem) =>
    !normalizedSearch ||
    item.label.toLowerCase().includes(normalizedSearch) ||
    item.id.toLowerCase().includes(normalizedSearch);
  const matchedItems = items.filter(matchesSearch);

  if (normalizedSearch) {
    const matchedIds = new Set(matchedItems.map((item) => item.id));
    const selectedItemsOutsideSearch = items.filter(
      (item) => isMarketplaceFacetItemSelected(item, selectedValues, selectedId) && !matchedIds.has(item.id),
    );

    return {
      matchedItems,
      visibleItems: [...selectedItemsOutsideSearch, ...matchedItems],
      canToggle: false,
    };
  }

  const limitedCount = Math.max(1, visibleOptionCount);

  if (expanded || items.length <= limitedCount) {
    return {
      matchedItems,
      visibleItems: matchedItems,
      canToggle: items.length > limitedCount,
    };
  }

  const defaultItems = items.slice(0, limitedCount);
  const defaultIds = new Set(defaultItems.map((item) => item.id));
  const selectedItemsOutsideDefault = items.filter(
    (item) => isMarketplaceFacetItemSelected(item, selectedValues, selectedId) && !defaultIds.has(item.id),
  );
  const visibleItems = [...defaultItems, ...selectedItemsOutsideDefault];
  const visibleIds = new Set(visibleItems.map((item) => item.id));

  return {
    matchedItems,
    visibleItems,
    canToggle: items.some((item) => !visibleIds.has(item.id)),
  };
}

export interface MarketplaceFacetRailProps {
  title?: ReactNode;
  description?: ReactNode;
  allLabel?: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
  searchable?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  searchEmptyLabel?: ReactNode;
  showMoreLabel?: ReactNode;
  showLessLabel?: ReactNode;
  visibleOptionCount?: number;
}

export function MarketplaceFacetRail({
  title = "Browse Categories",
  description = "Narrow the marketplace by category and current catalog depth.",
  allLabel = "All Categories",
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect,
  searchable = false,
  searchLabel = "Search options",
  searchPlaceholder,
  searchEmptyLabel = "No matching options",
  showMoreLabel = "Show more",
  showLessLabel = "Show less",
  visibleOptionCount = DEFAULT_MARKETPLACE_FACET_VISIBLE_OPTIONS,
}: MarketplaceFacetRailProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const multiple = selectionMode === "multiple";
  const normalizedSearch = search.trim().toLowerCase();
  const { matchedItems, visibleItems, canToggle } = getProgressiveMarketplaceFacetItems({
    items,
    normalizedSearch,
    selectedValues,
    selectedId: selectedId ?? "",
    expanded,
    visibleOptionCount,
  });

  return (
    <section className="min-w-0 space-y-3 border-b border-muted/70 pb-4 last:border-b-0 last:pb-0">
      <div className="space-y-1 px-1">
        <h2 className="font-heading text-base font-semibold text-foreground">{title}</h2>
        {description ? <div className="text-sm text-secondary">{description}</div> : null}
      </div>
      {searchable ? (
        <SearchInput
          label={searchLabel}
          hideLabel
          placeholder={searchPlaceholder ?? searchLabel}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      ) : null}
      <div className="space-y-2">
        <Button
          tone={!selectedId && (!selectedValues || selectedValues.size === 0) ? "primary" : "ghost"}
          size="sm"
          onClick={() => onSelect("")}
          leadingIcon="grid"
          aria-pressed={!selectedId && (!selectedValues || selectedValues.size === 0)}
          block
        >
          {allLabel}
        </Button>
      </div>
      <div className="space-y-2">
        {visibleItems.map((item) => {
          const selected = isMarketplaceFacetItemSelected(item, selectedValues, selectedId ?? "");

          return (
            <Button
              key={item.id}
              tone={selected ? "primary" : "ghost"}
              size="sm"
              onClick={() => onSelect(item.id)}
              leadingIcon={multiple && selected ? "check" : "tag"}
              aria-pressed={selected}
              block
            >
              {item.count == null ? item.label : `${item.label} (${item.count})`}
            </Button>
          );
        })}
        {normalizedSearch && matchedItems.length === 0 ? (
          <div className="rounded-tokenMd border border-dashed border-muted bg-surface-2 px-3 py-2 text-sm font-semibold text-secondary">
            {searchEmptyLabel}
          </div>
        ) : null}
        {canToggle ? (
          <Button
            tone="ghost"
            size="sm"
            onClick={() => setExpanded((current) => !current)}
            leadingIcon={expanded ? "chevronUp" : "chevronDown"}
            aria-expanded={expanded}
            block
          >
            {expanded ? showLessLabel : showMoreLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export interface MarketplaceFacetStripProps {
  title?: ReactNode;
  ariaLabel?: string;
  allLabel: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
  allLeadingIcon?: IconName;
  itemLeadingIcon?: IconName;
}

export function MarketplaceFacetStrip({
  title,
  ariaLabel,
  allLabel,
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect,
  allLeadingIcon = "grid",
  itemLeadingIcon = "tag",
}: MarketplaceFacetStripProps) {
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const multiple = selectionMode === "multiple";

  return (
    <section className="grid min-w-0 gap-2" aria-label={ariaLabel ?? (typeof title === "string" ? title : allLabel)}>
      {title ? <div className="font-heading text-sm font-semibold text-foreground">{title}</div> : null}
      <div className="w-full min-w-0 overflow-x-auto">
        <div className="flex min-w-max gap-2 pb-1">
          <Button
            tone={!selectedId && (!selectedValues || selectedValues.size === 0) ? "primary" : "ghost"}
            size="sm"
            onClick={() => onSelect("")}
            leadingIcon={allLeadingIcon}
            aria-pressed={!selectedId && (!selectedValues || selectedValues.size === 0)}
          >
            {allLabel}
          </Button>
          {items.map((item) => {
            const selected = selectedValues?.has(item.id) ?? selectedId === item.id;

            return (
              <Button
                key={item.id}
                tone={selected ? "primary" : "ghost"}
                size="sm"
                onClick={() => onSelect(item.id)}
                leadingIcon={multiple && selected ? "check" : itemLeadingIcon}
                aria-pressed={selected}
              >
                {item.count == null ? item.label : `${item.label} (${item.count})`}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export interface MarketplaceFacetChoiceGroupProps {
  title: ReactNode;
  description?: ReactNode;
  allLabel: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
  allLeadingIcon?: IconName;
  itemLeadingIcon?: IconName;
  searchable?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  searchEmptyLabel?: ReactNode;
  showMoreLabel?: ReactNode;
  showLessLabel?: ReactNode;
  visibleOptionCount?: number;
}

export function MarketplaceFacetChoiceGroup({
  title,
  description,
  allLabel,
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect,
  allLeadingIcon = "grid",
  itemLeadingIcon = "tag",
  searchable = false,
  searchLabel = "Search options",
  searchPlaceholder,
  searchEmptyLabel = "No matching options",
  showMoreLabel = "Show more",
  showLessLabel = "Show less",
  visibleOptionCount = DEFAULT_MARKETPLACE_FACET_VISIBLE_OPTIONS,
}: MarketplaceFacetChoiceGroupProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const anySelected = selectedValues ? selectedValues.size > 0 : Boolean(selectedId);
  const multiple = selectionMode === "multiple";
  const normalizedSearch = search.trim().toLowerCase();
  const { matchedItems, visibleItems, canToggle } = getProgressiveMarketplaceFacetItems({
    items,
    normalizedSearch,
    selectedValues,
    selectedId,
    expanded,
    visibleOptionCount,
  });

  const renderChoice = (id: string, label: string, count: number | undefined, selected: boolean, icon: IconName) => (
    <button
      key={id || "__all__"}
      type="button"
      aria-label={count == null ? label : `${label} (${count})`}
      aria-pressed={selected}
      onClick={() => onSelect(id)}
      className={cx(
        "focus-ring flex w-full items-center justify-between gap-3 rounded-tokenMd border text-left font-semibold transition",
        controlHeightClasses.md,
        controlPaddingClasses.md,
        controlTextClasses.md,
        selected
          ? "border-accent bg-accent text-inverse shadow-tokenSm"
          : "border-muted bg-surface text-foreground hover:border-accent hover:bg-elevated",
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        {multiple && id ? (
          <span
            aria-hidden="true"
            className={cx(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-tokenSm border",
              selected ? "border-inverse text-inverse" : "border-muted bg-surface-2",
            )}
          >
            {selected ? <Icon name="check" size="sm" tone="inverse" /> : null}
          </span>
        ) : (
          <Icon name={icon} size="sm" tone={selected ? "inverse" : "accent"} />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      {count == null ? null : (
        <span
          className={cx(
            "shrink-0 rounded-tokenFull px-2 py-0.5 text-xs tabular-nums",
            selected ? "bg-accent-contrast/20 text-inverse" : "bg-surface-2 text-secondary",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <section className="grid gap-3" aria-label={typeof title === "string" ? title : undefined}>
      <div className="space-y-1">
        <h3 className="m-0 font-heading text-sm font-semibold text-foreground">{title}</h3>
        {description ? <div className="text-sm leading-5 text-secondary">{description}</div> : null}
      </div>
      {searchable ? (
        <SearchInput
          label={searchLabel}
          hideLabel
          placeholder={searchPlaceholder ?? searchLabel}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      ) : null}
      <div className="grid gap-2">{renderChoice("", allLabel, undefined, !anySelected, allLeadingIcon)}</div>
      <div className="grid gap-2">
        {visibleItems.map((item) =>
          renderChoice(
            item.id,
            item.label,
            item.count,
            isMarketplaceFacetItemSelected(item, selectedValues, selectedId),
            itemLeadingIcon,
          ),
        )}
        {normalizedSearch && matchedItems.length === 0 ? (
          <div className="rounded-tokenMd border border-dashed border-muted bg-surface-2 px-3 py-2 text-sm font-semibold text-secondary">
            {searchEmptyLabel}
          </div>
        ) : null}
        {canToggle ? (
          <Button
            tone="ghost"
            size="sm"
            onClick={() => setExpanded((current) => !current)}
            leadingIcon={expanded ? "chevronUp" : "chevronDown"}
            aria-expanded={expanded}
            block
          >
            {expanded ? showLessLabel : showMoreLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export interface MarketplaceMobileFilterBarProps {
  title?: ReactNode;
  summary?: ReactNode;
  activeFilterCount?: number;
  openLabel?: ReactNode;
  activeFilterLabel?: ReactNode;
  ariaLabel?: string;
  onOpen: () => void;
  clearAction?: ReactNode;
}

export function MarketplaceMobileFilterBar({
  title = "Filters",
  summary,
  activeFilterCount = 0,
  openLabel = "Filters",
  activeFilterLabel,
  ariaLabel = "Search filters",
  onOpen,
  clearAction,
}: MarketplaceMobileFilterBarProps) {
  const hasActiveFilters = activeFilterCount > 0;

  return (
    <section className="grid min-w-0 gap-2 lg:hidden" aria-label={ariaLabel}>
      <div className="modern-surface rounded-tokenLg border border-muted p-3 shadow-tokenSm">
        <div className="grid gap-3 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon name="filter" size="sm" tone="accent" />
                {title}
              </span>
              {hasActiveFilters ? (
                <Badge tone="accent">{activeFilterLabel ?? `${activeFilterCount} active`}</Badge>
              ) : null}
            </div>
            {summary ? <div className="mt-1 text-sm leading-5 text-secondary">{summary}</div> : null}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 min-[420px]:flex min-[420px]:items-center">
            <Button
              type="button"
              tone={hasActiveFilters ? "primary" : "secondary"}
              size="sm"
              leadingIcon="filter"
              onClick={onOpen}
            >
              {openLabel}
            </Button>
            {clearAction}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface MarketplaceFilterBottomSheetProps extends Omit<BottomSheetProps, "children" | "trigger"> {
  children?: ReactNode;
  resultSummary?: ReactNode;
}

export function MarketplaceFilterBottomSheet({
  children,
  resultSummary,
  footer,
  ...rest
}: MarketplaceFilterBottomSheetProps) {
  return (
    <BottomSheet {...rest} height="expanded" footer={footer}>
      <div className="grid gap-5">
        {resultSummary ? (
          <div className="rounded-tokenMd border border-muted bg-surface-2 px-3 py-2 text-sm font-semibold text-foreground">
            {resultSummary}
          </div>
        ) : null}
        {children}
      </div>
    </BottomSheet>
  );
}
