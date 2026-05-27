# Search Activity Option Counts

## Goal

When shoppers filter search results to items with listings or offers, dimension option counts should reflect the matching market activity rows for each option instead of repeating the filtered item count for every option.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-search-activity-option-counts`
- Branch: `codex/search-activity-option-counts`
- Base: fetched `origin/main`
- Sandbox: pending dependency install and doctor check

## Context Evidence

- Discovery owns product search read models, result filtering, and facet presentation.
- Marketplace owns listing and offer facts; Discovery projects the market facts it needs into `discovery_market_listings` and `discovery_offer_demand_matches`.
- Catalog dimensions and options are exposed to Discovery through `discovery_search_items.dimension_filter_values`.
- The current dimension facet value query counts `DISTINCT item.catalog_item_id`, so after `marketActivity=listings` filters the item set, sibling options can all display the same item count.

## Decisions

- Keep the fix inside Discovery search read-model queries; do not move Marketplace behavior or introduce cross-context UI coupling.
- Preserve item-based facet counts when no market activity filter is active.
- Under `marketActivity=listings`, count active available listing rows whose selected options contain the displayed dimension option.
- Under `marketActivity=offers`, count submitted offer rows whose selected options contain the displayed dimension option.
- Under `marketActivity=any`, count both matching listing and offer rows with `UNION ALL`, so the count represents available market activity for that option.
- Continue excluding the currently displayed dimension from sibling-option filtering so users can compare options within that dimension.
- Keep selected values visible even if their current market activity count falls to zero.

## Plan

1. Add targeted query coverage proving listing-backed dimension option counts differ per selected option.
2. Add shared market-activity source SQL for dimension facet value counts.
3. Branch `loadDimensionFacetValues` to use market-row counts only when `marketActivity` is active.
4. Run focused Discovery search tests and available repo checks.
5. Publish a PR, wait for CI, merge, verify staging and production deployments, then clean up the worktree and branch.

## No Blocking Questions

The user report and existing bounded-context evidence are enough to proceed.
